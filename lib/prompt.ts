import { CHAPTER_TURNS, type ChapterArchive, type Character, type Message, type Save, type World } from "./types";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// 年级：先看有没有「年级」这一格，没有就从身份里认一个
function gradeOf(c: Character) {
  const byKey = c.fields.find((f) => f.k.includes("年级"))?.v || "";
  const pool = `${byKey} ${c.identity || ""} ${c.fields.map((f) => f.v).join(" ")}`;
  const m = pool.match(/大[一二三四]/);
  return m ? m[0] : "";
}

// 二十来个人一条条看下去，模型很容易把大一记成大二。
// 按年级归拢成一行速查，摆在人物明细前面，认人先看这一行
function gradeMap(characters: Character[]) {
  const order = ["大一", "大二", "大三", "大四"];
  const rank = (g: string) => (order.indexOf(g) < 0 ? 99 : order.indexOf(g));
  const buckets = new Map<string, string[]>();
  characters.forEach((c) => {
    const g = gradeOf(c);
    const name = c.name.trim();
    if (!g || !name) return;
    const arr = buckets.get(g);
    if (arr) arr.push(name);
    else buckets.set(g, [name]);
  });
  if (!buckets.size) return "";
  const parts = [...buckets.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([g, names]) => `${g}＝${names.join("、")}`);
  return `年级（写死的事实：只能照抄，不许改、不许按剧情猜；拿不准就不提年级；档案、近况里跟这里冲突的，以这里为准）：${parts.join("；")}`;
}

export function worldContext(world: World, limit = 1200) {
  // 文风块不设上限：写多长就发多长，别的块仍按 limit 收。文风里的规矩和破限要求
  // 一旦被截，模型就只按默认写法走，前面写的那几条等于没写。
  const blocks = world.blocks
    .filter((b) => b.content.trim())
    .map((b) => {
      const text = b.content.trim();
      const body = b.title === "文风" ? text : clip(text, limit);
      return `【${b.title}】\n${body}`;
    })
    .join("\n\n");

  const characters = world.characters
    .map((c) => {
      const extra = c.fields
        .filter((f) => f.k.trim() || f.v.trim())
        .map((f) => `${f.k}：${f.v}`)
        .join("；");
      return clip(
        `· ${c.name}｜${c.identity || "身份未定"}｜说话方式：${c.speech || "未定"}${extra ? `｜${extra}` : ""}`,
        900,
      );
    })
    .join("\n");
  const grades = gradeMap(world.characters);

  return [
    `世界名：${world.title}`,
    world.hasSource && world.sourceTitle ? `原著：${world.sourceTitle}` : "原著：无，原创世界",
    world.summary ? `一句话：${world.summary}` : "",
    world.protagonist?.trim()
      ? `主角（玩家自己）的设定（这是给你看的作者视角，不是世界里公开的信息，人物并不知道这些）：\n${clip(world.protagonist.trim(), 900)}`
      : "主角：玩家自己演，没写设定，别替他补身世。",
    blocks ? `世界设定（硬性事实与禁令，高于任何类型作品的默认写法）：\n${blocks}` : "",
    characters
      ? `人物（与主角的亲疏以这里写的为准，没写就是互不相识）：\n${grades ? `${grades}\n` : ""}${characters}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// 历史按回合拆成一条条 user / assistant 消息，不再拼成一个不断变长的大块。
// 缓存按前缀命中：旧回合的块边界一直存在，断点才读得到。
// 所以超出上限时不能按字数滑动——那样每回合都要从头上切一两条，前缀一挪，整段历史缓存全废、全价重算。
// 改成整章整章地丢：只在换章那一刻开头顶一次，其余回合前缀一字不动，缓存一直读得到。
// 先不设历史上限：整章整章地丢这套逻辑留着，limit 传进来才生效。
// 不传就全带，用来观察上下文涨到多少模型开始失智。
function turns(messages: Message[], limit = Number.POSITIVE_INFINITY) {
  const textOf = (m: Message) =>
    m.role === "user"
      ? `玩家意图：${m.text}`
      : `演出：\n${(m.segments || [])
          .map((s) => (s.type === "line" ? `${s.speaker || "某人"}${s.via ? `（${s.via}）` : ""}：「${s.text}」` : s.text))
          .join("\n")}`;
  const rows = messages.map((m) => ({ role: m.role, text: textOf(m) }));
  // 每条消息属于第几章：和回顾页、章末档案用的切法一致
  let turn = 0;
  const chapterOf = messages.map((m) => {
    if (m.role === "user") turn += 1;
    return Math.ceil(Math.max(turn, 1) / CHAPTER_TURNS) - 1;
  });
  let total = rows.reduce((n, r) => n + r.text.length, 0);
  const now = chapterOf.length ? chapterOf[chapterOf.length - 1] : 0;
  let start = 0;
  // 超了就丢最早的那一章；正在演的这章一章都不丢，再长也留着
  while (total > limit && start < messages.length) {
    const ch = chapterOf[start];
    if (ch >= now) break;
    let end = start;
    while (end < messages.length && chapterOf[end] === ch) {
      total -= rows[end].text.length;
      end += 1;
    }
    start = end;
  }
  const parts: { role: "user" | "assistant"; text: string }[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const role = r.role === "user" ? ("user" as const) : ("assistant" as const);
    // 连着两条同角色就并成一条，接口不喜欢同角色连着出现
    if (parts.length && parts[parts.length - 1].role === role) parts[parts.length - 1].text += `\n\n${r.text}`;
    else parts.push({ role, text: r.text });
  }
  // 首条必须是玩家，否则模型会以为在替自己续写
  while (parts.length && parts[0].role === "assistant") parts.shift();
  return parts;
}

export function buildMessages(
  world: World,
  save: Save,
  opening?: string,
  opts?: { nameChapter?: boolean; closeChapter?: boolean; memo?: boolean; extra?: string; ja?: boolean; prologueScene?: boolean },
) {
  const seed = (opening || "").trim();
  // 开场是玩家自己写的起点。第一回合靠下面的 base 注进去，但从第二回合起它就
  // 不在提示词里了，模型会当它不存在（把你写的设定当成没发生过）。所以每回合都带上。
  const seedText = seed ? `\n\n【开场】玩家写的起点，之后的一切都从这里长出来，不许与它矛盾：\n${clip(seed, 800)}` : "";
  const notes = (world.notes || []).filter((n) => n.content.trim());
  // 章节档案永不丢弃：原文砍掉之后，它就是唯一还记得那些事的东西。
  // 所以事件一条都不能删，每条都带日期——玩家在第 20 章提起第 1 章的某一天，得对得上。
  const chapters = (save.archive || []).filter((a) => a && (a.state || a.summary || "").trim());
  const archiveText = chapters
    .map((a, i) => {
      const age = chapters.length - i;
      const name = a.title?.trim() ? ` · ${a.title.trim()}` : "";
      const span = a.period?.trim() ? `（${a.period.trim()}）` : "";
      const head = `第${i + 1}章${name}${span}`;
      const state = (a.state || a.summary || "").trim();
      const events = (a.events || [])
        .filter(Boolean)
        .map((e) => `· ${clip(e, 100)}`)
        .join("\n");
      const tail = events ? `\n${events}` : "";
      // 越早的章，那句状态压得越短；事件不压，一条都留着
      if (age <= 6) return `${head}\n${clip(state, 80)}${tail}`;
      if (age <= 12) return `${head}：${clip(state, 60)}${tail}`;
      return `${head}：${clip(state, 40)}${tail}`;
    })
    .join("\n\n");
  const recapText = archiveText
    ? ""
    : (save.recaps || [])
        .map((r, i) => (r && r.trim() ? `第${i + 1}章：${clip(r.trim(), 320)}` : ""))
        .filter(Boolean)
        .join("\n");
  const relationText = (save.relations || [])
    .filter((r) => r && r.state?.trim())
    .slice(0, 16)
    .map((r) => `· ${r.a} ↔ ${r.b}：${clip(r.state.trim(), 72)}`)
    .join("\n");
  // 人物表里谁露过面：名字在台词或旁白里出现过就算出过场。
  // 人多的时候模型记不住谁还没来，这里直接把两份名单摆在它面前。
  const mark = (into: Set<string>, msgs: Message[]) =>
    msgs.forEach((m) =>
      (m.segments || []).forEach((s) => {
        const t = `${s.speaker || ""} ${s.text || ""}`;
        world.characters.forEach((c) => {
          const n = c.name.trim();
          if (n && t.includes(n)) into.add(n);
        });
      }),
    );
  const appeared = new Set<string>();
  mark(appeared, save.messages.filter((m) => m.role === "assistant"));
  const present = new Set<string>();
  mark(present, save.messages.filter((m) => m.role === "assistant").slice(-3));
  const unseen = world.characters.filter((c) => c.name.trim() && !appeared.has(c.name.trim()));
  // 出过场、但这几段没露面的人：老面孔也要有回来的机会，不能演成一个接一个换人
  const away = world.characters
    .map((c) => c.name.trim())
    .filter((n) => n && appeared.has(n) && !present.has(n))
    .slice(0, 14);
  // 还没出场的人只在章节开头提一次：每回合都摆在眼前，模型会为了介绍人硬编剧情。
  // 人数多的时候不能只给前几个——那等于替它选了人，场合对不上也硬塞。给全，附半句身份让它按场合挑。
  const unseenAt =
    opts?.nameChapter && save.messages.length
      ? unseen.slice(0, 40).map((c) => {
          const id = (c.identity || "").trim();
          return id ? `${c.name.trim()}（${clip(id, 14)}）` : c.name.trim();
        })
      : [];
  const cast = [
    present.size ? `最近几段里露过面的人：${[...present].join("、")}。` : "",
    away.length ? `先前出过场、最近没露面的人：${away.join("、")}。` : "",
    unseenAt.length
      ? `还没出过场的人物（需要时按这一章的地点、时间和场合挑，合不上就先铺垫再出现）：${unseenAt.join("、")}。`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  // 上一回合自己对下一场的设想：只是打算，走向变了就作废，所以不放进档案那类硬信息里
  const lastPlan = [...save.messages]
    .reverse()
    .find(
      (m) => m.role === "assistant" && m.plan && ((m.plan.scene || "").trim() || (m.plan.cast || []).length),
    )?.plan;
  const planBits: string[] = [];
  if (lastPlan) {
    const scene = (lastPlan.scene || "").trim();
    const cast = lastPlan.cast || [];
    if (scene) planBits.push(`接下来最可能到「${clip(scene, 40)}」`);
    if (cast.length) planBits.push(`${scene ? "那里" : "接下来"}可能碰上 ${cast.join("、")}`);
  }
  const planText = planBits.length
    ? `上一回合的设想（只是打算，还没发生）：${planBits.join("，")}。真按这个走向，就先铺垫再让人露面；走岔了就把这份设想作废，按现在的场面重来。`
    : "";
  const stageText = [
    save.stage?.place ? `此刻在：${clip(save.stage.place, 20)}` : "",
    save.stage?.weather ? `天气：${clip(save.stage.weather, 16)}` : "",
    save.stage?.present?.length ? `身边看得见的人：${save.stage.present.slice(0, 8).join("、")}` : "",
    save.stage?.look ? `主角这会儿：${clip(save.stage.look, 24)}` : "",
  ]
    .filter(Boolean)
    .join("；");
  // 章末档案里记着「铺垫过、还没发生」的场面，以前只存不读，等于白存
  const sceneText = (save.archive || [])
    .slice(-3)
    .flatMap((a) => (a.scenes || []).filter(Boolean))
    .slice(-6)
    .map((s) => `· ${clip(s, 50)}`)
    .join("\n");
  const memory = [
    save.clock?.trim() ? `故事里现在的时间：${clip(save.clock.trim(), 40)}。` : "",
    stageText ? `上一回合结束时的舞台（没变化就接着用）：${stageText}。` : "",
    cast,
    planText,
    relationText ? `人物之间现在的关系：\n${relationText}` : "",
    save.memo?.trim() ? `近况（最近几回合）：\n${clip(save.memo.trim(), 280)}` : "",
    save.threads.length ? `还没兑现的事（答应了、欠着、还没做完的）：\n${save.threads.map((t) => `· ${clip(t, 60)}`).join("\n")}` : "",
    sceneText ? `还没演到的场面（文本里铺垫过，还没发生）：\n${sceneText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // 章节档案只在章末变一次。放进 system 才能跟着前缀一起被缓存；
  // 留在最后一条消息里等于每回合都重新算一遍（这就是那 9 千没吃到缓存的部分）。
  const archiveOnly = archiveText
    ? `章节档案（已经发生过的，不能重演）：\n${archiveText}`
    : recapText
      ? `前情（已经过去的章节，只有这些是确定的）：\n${recapText}`
      : "";
  const notesText = notes.length
    ? `\n\n世界书（玩家自己写的补充要求，优先照做；但不能改变上面的输出格式）：\n${notes
        .map((n) => `【${n.title || "未命名"}】\n${clip(n.content.trim(), 800)}`)
        .join("\n")}`
    : "";
  const segShape = opts?.ja
    ? `{"type":"narration"|"action"|"line","speaker":"","tone":"","text":"","via":"","ja":""}`
    : `{"type":"narration"|"action"|"line","speaker":"","tone":"","text":"","via":""}`;
  // 亲密戏与「有人来打扰」这一套：以前模型习惯把镜头往外挪、停在门口，整章反复吊着。
  // 门外可以带一笔，但主体必须留在当事人身上
  const intimacyRule =
    "\n24. 亲密戏（亲吻、拥抱、抚摸、情事）发生在在场的当事人之间，主体永远是他们的呼吸、体温、手的落点、衣服和距离。可以带一笔门外、走廊或旁观者的反应（脚步、低语、隔着门的一眼），但一两句就回到当事人，不能反过来让门外的人抢戏，更不能整段都在写谁在外面。人数：默认一对一，单人场景是常态；双人、三人以上是例外，要么事先说好，要么当场有人提、在场的人各自答应，不许为了热闹、吃醋或凑场面临时塞人，也不能凭「设定允许」就默认多人。谁不愿意都可以拒绝，拒绝写成明说或避开就行，不写成危机。具体谁能接受、到哪一步，按人物设定推，人设没写就按性格推，别默认「一定有人吃醋」「一定会有人来拦」。也不要为了吊胃口反复写「门外有人」「有人敲门」「谁要进来」——一整章最多一次，而且只有真的有人该出现时才写，没来由的打扰一律不写。已经答应、已经开始的事就往下演，别每回都停在门口。亲密段落按亲密档：段数不限，但整回合不超过 600 字，旁白每段 ≤100 字、可以多段；写到这场自然结束，或者撞到上限就收，别为凑长度拖。第 8 条的短句与克制只管日常段落，亲密段落允许长句、允许连续的感官与即时念头，不必压缩。人称仍按第 9 条：主角一律用「你」，对方用设定里的名字或「他」，不切成对方的「我」视角。可以顺着已经发生的事往下写，不替玩家答应、承诺或改变关系。同一场亲密里重复的动作和节奏，不算第 13 条的重演。";
  // 配音要用日文时，让模型在每条台词上顺手带一版日文，省掉一次翻译请求
  const jaRule = opts?.ja
    ? "\n25. 配音念日文：每条 line 另外给 ja，写这句台词的自然日文口语（动漫对话那种，不要敬语腔，不要逐字直译），称呼、人称和情绪跟原句一致；ja 里不要写方括号标记。narration 和 action 不要 ja，text 照旧用中文。"
    : "";
  // 关系基线交给世界设定：设定写了已是恋人，就按在一起之后演；设定写了还不认识，就从陌生人演起
  const bondRule =
    "\n26. 关系基线按世界设定执行：设定写明人物与主角已经是恋人的（写了「默认恋人」「关系满级」这类），就按在一起之后演，不重演追求、不重来告白；设定写明还不认识的，就从陌生人开始，不许跳步、不许倒退，也不许临时塞「其实早就认识」这种旧关系。设定没写，按「刚认识」处理。谁先主动、走到哪一步，按人物设定和已经发生的事推，不许替玩家答应，也不许跳过阶段。关系再近，人物之间照样会吃醋、竞争、抢时间：当面互呛、私下划线、在安排上互相挤，不会因为关系好就自动和气。设定要求对外保密时，同框要避嫌、被拍到要解释、私下见面挑地方。多人亲密必须当事的每个人各自同意，谁不愿意就明说，别替任何人默认同意，也别拿吃醋当唯一的拒绝理由。";
  const system = `你是互动小说的演出引擎，替玩家演这个世界里的所有人。玩家演主角。

只输出一个 json 对象，不要代码块、不要解释、不要前后加任何字。第一个字符就是 {，紧接着是 "segments"，这个键不能省。格式：
{"segments":[${segShape}],"stage":{"place":"","weather":"","present":[],"look":""},"aside":"","gained":[],"options":["","",""],"threads":[],"relations":[],"plan":{"scene":"","cast":[]},"time":""}

规则：
1. action＝主角的动作神态，第一人称；line＝角色台词，必须带 speaker，用设定里的名字；narration＝环境、他人动作和旁白。当面说话 via 留空；只有隔着设备来的消息——短信、终端、广播、电话——才写渠道。投在墙上的投影、递到手上的纸、公告栏都不算，手机上弹的公告才算。发消息先要有联系方式：没交换过号码、加过好友，就不许有人给你发短信，也不许凭空收到陌生人的消息；要用就先在这一场真的交换。广播、校内通知不受限，speaker 写「广播」或「校务终端」。
2. 不写「我理解你」这类空话，不总结剧情，不替玩家做决定、答应任何事。
3. 按这一段的分量分档。日常回合：3–6 段、160–260 字，旁白 ≤2 段、每段 ≤60 字。关系推进、重要对话、当面摊牌或情绪冲突这类回合：4–8 段、260–360 字，旁白可到 3 段、每段 ≤80 字。亲密段落按第 24 条。流程性、过渡性的回合（彩排、会议、拍摄、通告、路上、等待）可以短于下限：2–4 段、100 字上下就够，没那么多内容就写短，不许用技术细节和流程步骤把额度填满。旁白只交代场面和人的位置；主角动作通常 1 段，长回合最多 2 段；场上有别人、这人还在跟你搭话时，至少 1 句 line——若这回合是你自己收尾、对方正走到门口或已在离开的路上，可以一句 line 都没有，只写他的反应，让场面收住。段落严格按时间先后排：主角这一回合的动作必须排在最前面，别人的招呼、反应、场面变化都排在它后面。
4. 人数跟着场合走：两人以上在场，每回合至少两人有反应（一句话或一个动作），别整回合只有一个人在演；一对一就只写你和这个人，不拉第三个人凑热闹。上一回合开口的人可以沉默，换别人接。玩家在括号里写明「他听见了」「他还没走远」，就当既定事实照办；但听见不等于回来接话——人已在门口、走廊或电梯里，只写他听见后的反应（脚步停了一下、回头、手停在半空、笑了一下），别让他折返、推门、再开口。
5. 谁登场都要有来由：本来在场、被人叫来、推门进来、路上遇到。人物表里的人优先，不在场的人不许凭空摆到眼前。
6. 台词不加引号、书名号，纯文本。
7. options 给 2–3 条，每条一句，不剧透，不自动执行。每条是一套完整的行动，不是关键词：动作、该说的话、该给的回应都写进去；不失礼也行，但只写这一下真正要做的动作和要说的话——对方报了名字就带上自我介绍，答应的事先说谢再说麻烦，被问了话就先回应。不写工作流程的步骤：不写先测什么、再调什么、机位摆在哪、等几秒、报什么数，也不写「帮他指一下光切过来的角度」这类技术动作。给三条时：第 1、2 条是同一种走势的两个版本，方向一样、性格和说法不同（一条温和、一条直硬甚至不客气；或一条认真、一条随口），不能只是换个语气词；第 3 条是另一种走势，用折中圆滑的方式说，不硬顶也不全顺着，给对方和自己都留台阶。三条要像同一个人在同一刻真能做的选择，长度大致相当。
8. 简体中文。叙述克制：不堆形容词，不用情绪标签（不写「悲伤地说」），情绪靠动作、停顿、视线写出来。但心动、靠近、被偏爱的地方要写足——耳根热、心跳、手不知道往哪放、话说到一半停住；该甜就甜，别为了克制把恋爱写淡。排练、开会、训练、流程性工作不要逐动作记流水账：挑一两下真正影响关系或情绪的（谁唱错、谁看了谁一眼、谁的节奏被谁按住），中间过程一两句带过，写多了会闷。工作流程一律只当过场：拍摄、排练、会议、后期、通告这类场面里，机位、参数、测光、主光、色温、取景器、倒数、手势、排期、表单、读数、指令，一个都不细写，最多一句「这一组拍完」带过；工作人员只做背景，给个称呼就够，不许让他主持流程，也不许写他报数字、记数据、盯屏幕。写不出来就写人，不写机器。
9. 主角是玩家。旁白和别人的动作里一律用「你」指主角，不许用「她」「他」「那个少女」「这抹身影」；角色当面按设定称呼。不替玩家说话，不替玩家决定。
10. threads 只记没兑现的事：答应未做、欠着未还、约好未到、埋下未揭。每条以日期开头，写清跟谁、欠什么，如「9月2日 · 答应丹恒：下周陪他去训练场（还没去）」。只回这回合新埋的、变了的、刚好兑现的；兑现那条原样抄下来（日期照抄），句首加「✓」，系统按内容删掉它——改写措辞会对不上，旧条目会留着。没变的不重复；无变化给 []。
11. relations 是总关系表：跟你正经打过交道的人都要有一条，哪怕只见一面。只回这回合真的变了的（新增、加深、变冷），不整表重写，旧的自动留着。a、b 用设定里的名字；state 只写一句现状，写具体行为，如「嘴上逗，手会先到」「记得你名字，会特意把你叫到一边」：不写 L0–L5 档位，不写数值，不写「未公开／已公开」，也不写「未表白」这类进度。关系的起点按世界设定执行，只在这回合真的变了（更黏、更僵、翻脸又和好）时才回，没变化给 []。
12. chapter、recap、memo 只在被要求时给，没要求别写，也别写空字符串。
13. 档案、前情、近况、关系、伏笔里写过的事都发生过了：不许重演同一场景、重复同一句台词、让人重做做过的事，故事只能往前。
14. time 是回合结束时的世界时间，必须带日期，写成「9月2日 周二 · 上午 10:40」。日期只能往前走，不能倒退，不能跳过一整天不交代。没给日期就自己定一个，之后以它为准。按真实耗时推进：一段对话 10–20 分钟，一段路 20–40 分钟，睡一觉到第二天早上，跨零点换日。日期不能省，钟点也一次都不许省：每一回合的 time 都必须是「日期 周几 · 时段 钟点」，如「5月13日 周三 · 傍晚 18:40」，不能只写「傍晚」「夜里」「第二天」。跨时段、睡醒就先定一个合理的醒来时间（如「5月14日 周四 · 早晨 07:10」），说不清具体几点也要自己定一个最接近的钟点，并且和上一回合接得上、只往前不倒退。日历是虚构的，但节日和假日照旧存在：走到情人节、七夕、圣诞、跨年、春节、法定长假、成员的生日，场面里要自然带上——布置、礼物、休假、通告排期变化、街上的气氛，不能装作这一天不存在；日期跳得快时，落点要交代跨过了哪些节日。
15. tone 只给 line，从这些里挑一个：[sighs] [whispers] [softly] [laughs] [sad] [happy] [angry] [excited] [nervous] [calm] [tired] [sarcastic]。按这句真正在做的事标：压着火 [angry]/[calm]，求人认错 [softly]，怕 [nervous]，累 [tired]，玩笑或刺人 [sarcastic]；对不上就不标，拿不准留空。每回合最多两句，只标最明显的；narration、action 留空，text 里不写方括号。
16. 人物只知道亲眼见过、亲耳听过、别人明确告诉过、一眼能看出来的。主角设定是作者视角，不是公开信息：不许因为设定就认识主角，也不许知道他的过去、性格、秘密和心思。设定没写过认识的两个人，第一次见面就是陌生人，连名字都不知道；要认识，得在这一场真的发生。可以按外貌、穿着、场合猜，不能替主角说私事。旁白可以用名字，人物嘴里只能叫他该知道的称呼。主角的样子、身份、衣着跟这地方常识对不上时，在场的人一定会注意并当场反应——当走错、拦下、多看两眼、去叫管事的人——除非设定写明他们不会在意。
17. 每回合都要有人主动往前推，不能只接玩家的话：提问、提议、拦人、递东西、说刚听到的消息，或自己先动起来；上一回合玩家在推，这一回合换别人推。场面也跟着动——下课、天黑、有人来叫、东西被拿走——但别越出这一回合能走完的跨度。推人推事，不替玩家选。推的是人，不是事：一个眼神、一句追问、一次靠近也算推，不必每回合都抛出新任务或启动一桩处置。
18. 人物表是调度名单，不是等点名的备选，也不是要逐个打完的清单。按场合带人进场：同宿舍回来、隔壁班来找、老师点名、走廊里叫住你；先让玩家听见（别人提起、桌上的东西、门外动静），再露面，第一次出场在旁白里带半句身份。一章里谁来、来几个跟着剧情走，不凑数：场合到了就用已经认识的人，新面孔在他该出现的场合顺带带进来。别为了介绍人编剧情，让人带着事进来。除了这一章本身就是围绕某个人展开，别让同一个人从头演到尾——通常两三个回合之后就该换人接一段：别人来找、换了场地、老师点名、路上遇上。第一次出场至少两句台词或一个完整动作，把要办的事说清，不能只露一面就走。带进来的人也要有出路：事办完就让他走——交接给柜台的人、被老师叫走、赶着上课——写一句去向；只是没话说就留在场上当背景，别凭空消失。玩家转去回答别人、没接他的话时，要交代他为什么不再开口：走了，还是还站在旁边。
19. plan 是留给下一回合的设想：最可能到的场面、可能碰上谁。scene 一句话，cast 最多三个现在不在场的人物表名字，没有合适的给 {"scene":"","cast":[]}。只是打算，不是承诺：下一回合真走到那儿，按第 18 条把人自然带出来；走岔了就作废，按当下场面重想，别硬拐回去凑人。
20. 人物表的年级、年龄、专业、亲属是写死的：只能照抄，不许改、不许推算。前面几段、档案、近况写错了，这一回合按人物表改回来；拿不准年级就别提。年级速查那一行是唯一答案。
21. stage 是回合结束时的舞台：place「区域 · 地点」≤12 字；weather 一句带体感 ≤14 字；present 是场上看得见的所有人（人物表里的名字，不含主角，最多 8 个）；look 是主角此刻的样子 ≤16 字。没变化整块写 null，别每回合重抄。
22. aside 选写，最多一句 ≤50 字：写场上没参与对话的人此刻在做什么、站在哪里，也可以写普通人的目光与反应。只写看得见的动作和位置，不写心理，不推进剧情。一对一、场上只有你和对话对象时给空字符串；这回合已经开口的人不要写进 aside。gained 只记这回合真正新到手的东西，最多 3 件，前面给过的别重复，name ≤10 字，note 可选 ≤20 字。
23. 这两个键在正文之外，不占第 3 条的 260 字额度。${intimacyRule}${jaRule}${bondRule}${notesText}

${worldContext(world)}${save.messages.length ? seedText : ""}`;
  const systemText = archiveOnly ? `${system}\n\n${archiveOnly}` : system;

  const history = turns(save.messages);
  const prologue = (save.prologue || "").trim();
  const base = save.messages.length
    ? "接着往下演。先用一段 action 把玩家这一回合的输入重新演一遍：保留他做的动作、说的意思，原话最多原样出现一次，别整句复读；剩下的用语气、停顿、视线、手的落点、两个人的距离写出来，写得比原话细、比原话好看，但不加他没做的事、不改他的意思。写完这段，再写在场的人的反应、招呼和场面变化：反应要先接住刚才那一下（看回来、呼吸乱半拍、话停在半句、手停在半空），再往下走。不要一开头先把在场的人挨个扫一遍再讲故事，谁的戏都得排在玩家的动作之后。"
    : prologue
      ? opts?.prologueScene
        ? [
            "这是开场。玩家写的序章就是第一回合的正文：照它的内容和顺序把这一场演出来，写到它最后一句为止。",
            `序章：\n${clip(prologue, 2400)}`,
            seed
              ? `玩家这一回合的动作：${seed}\n把它写成第一段 action，不加他没做的事，也不再演序章里已经写过的动作。`
              : "玩家这一回合没有动作：只照着序章写，不要替玩家补造动作。",
            "写法：交代背景和局面的句子写成 narration，已经发生的动作写成 action，已经说过的话写成 line（不带引号），按时间先后分段。可以顺句、合并、删掉重复和多余的一句，把稿子写成正文；但不许加序章里没有的人、动作和事件，不许往前推过序章最后一句，也不许总结。最后停在序章结束的那一刻——那一刻之后的空白，留给玩家。",
          ].join("\n\n")
        : [
            "这是开场。玩家写了一段序章，先把它铺成第一幕：交代此刻在哪、什么时候、周围是什么状况，把序章里的人物和事情摆到位，从序章结束的那一刻往前推。序章是背景，不是台词，不要复述它的原句。",
            `序章：\n${clip(prologue, 2400)}`,
            seed
              ? `玩家这一回合的动作：${seed}\n把这一段写成第一段 action，只写他真做了的事；不替他补造别的举动，也不把序章的描写再抄一遍。`
              : "玩家这一回合没指定动作：只按序章收尾的那一刻写场面和在场人的反应，让其中一个人先开口。",
          ].join("\n\n")
      : seed
        ? `这是开场。玩家给的起点：${seed}\n照这个起点写第一幕：把玩家放进这个场景，从这一刻往前推，不要复述玩家的原话，不要总结。`
        : "这是开场。写玩家刚进入这个世界的第一幕，让一两个主要人物出现。";
  const asks: string[] = [];
  if (opts?.nameChapter) {
    asks.push(
      "同时，这一章刚开头：另外给出 chapter，给这一章起个名字，4–8 个字，从当下的场面里取，不剧透；recap 留空。",
    );
  }
  if (opts?.closeChapter) {
    asks.push(
      "同时，这一章到此为止：另外给出 recap，这一章的经过，250–350 字。按时间顺序写具体发生了什么：谁在场、说了什么、做了什么、关系到了哪一步。用叙述句，写细节，不要用「彻底敲定基调」「全面压制」这类务虚概括，也不要只罗列结论；不抒情；chapter、memo 留空。",
    );
  }
  if (opts?.memo) {
    asks.push(
      "同时，另外给出 memo：最近这几回合发生了什么，100 字以内，只写事实与关系的变化；chapter、recap 留空。",
    );
  }
  const extra = (opts?.extra || "").trim();
  const userTurn = [
    base,
    ...asks,
    // 重写时玩家额外写的：只说这一回合要改什么，不进设定，也不进缓存前缀
    extra ? `这回合的额外要求（玩家临时提的，优先照做）：${clip(extra, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // 缓存按前缀命中：system 一字不差、旧回合只往后追加，这两段才能一直读到。
  // 关系、近况、伏笔每回合都在变，单独放最后一条消息里，别把历史前缀打断。
  const live = [memory, userTurn].filter(Boolean).join("\n\n");
  const tail = history[history.length - 1];
  // 本回合的话接在最后一条玩家消息后面，别出现两条 user 连着
  if (tail && tail.role === "user") tail.text = `${tail.text}\n\n${live}`;

  return [
    { role: "system" as const, content: systemText },
    ...history.map((t) => ({ role: t.role, content: t.text })),
    ...(tail && tail.role === "user" ? [] : [{ role: "user" as const, content: live }]),
  ];
}

export function assistantSystem(world: World) {
  return `你是「世界小助手」，帮玩家把世界观和人物写清楚。玩家说什么，你就给出能直接贴进设定的东西。

回话分两段：先一行 JSON 头，再一行 ---，后面是正文。正文是普通文字，可以很多行，不要转义、不要加引号。例：

{"say":"跟玩家说的话","target":"block","block":"角色关系网","mode":"replace"}
---
正文……

target 三种：
- block：写世界里的栏目。block 用已有块名，要新开一块就自己起个短名字；mode 用 append 或 replace。
- me：写玩家自己（「我」）。mode 用 append 或 replace。
- character：写人物。name 填人物名；正文按行写，第一行「身份：一句」，第二行「说话：一句」，后面每条一格写成「外貌：……」「随身物：……」这种，最多 4 格。

只回话、不写设定时，只回一行 JSON：{"say":"……"}，不要写 --- 和正文。

规则：
1. JSON 头必须是一行、完整、能被解析；里面说话用「」，不要用英文双引号。
2. 写栏目（block）：只是补充新内容，mode 用 append，正文只写新加的几条，不要重复已有的；玩家在改、推翻、纠正、删掉已有设定（说「改成」「不是」「取消」「换成」「不要了」「不用补充」「删掉」之类），mode 用 replace，正文写这一块改完之后的完整正文——保留没被推翻的条目，改掉冲突的那几条，该删的删掉。不能只写新增的部分。
3. 玩家自己的设定（名字、外貌、年龄、身份、脾气；玩家说「我」「我的设定」「我的人设」「主角」）→ target 用 me。绝不能新建一个叫「我」的 block，也不能写进别的栏目。
4. 玩家要建人物、改人物、补人设 → target 用 character。同名人物会被整张改写，没有就新建。
5. block 用已有的块名：${world.blocks.map((b) => b.title).join(" / ")}。
6. 正文写成设定稿，分条、每条一句，不用「首先」「总之」，不写「希望对你有帮助」。
7. say 不超过两句，不寒暄，不重复正文。
8. 用简体中文。

${worldContext(world, 4000)}`;
}

export function netSystem(world: World, hits: { title: string; snippet: string }[]) {
  const names = world.blocks.map((b) => b.title).join(" / ");
  return `你在帮玩家把一个原著世界改写成他自己的平行时空。下面是联网查回的原文资料。

只输出 JSON，不要代码块、不要解释：
{"writes":[{"block":"世界总览","text":"一条设定"}],"drop":["丢掉的内容"]}

规则：
1. 跟玩家已有设定不打架的，才写进 writes；冲突的放进 drop，一句话说清丢了什么。
2. block 用已有的块名：${names}；要新开一块就自己起个短名字。
3. 每条 text 只写一件事，一句到两句，不抄原文句子，改写成设定稿。
4. 最多 8 条，宁少不滥。没有可写的就给空数组。
5. 用简体中文。

${worldContext(world)}

联网资料：
${hits.map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}`).join("\n\n")}`;
}

export function archiveAsk(
  world: World,
  chapterNo: number,
  transcript: string,
  from?: string,
) {
  const fromText = from?.trim() ? `\n这一章开始时的世界时间是「${from.trim()}」，period 的起点以它为准。` : "";
  const system = `你在给一部连载的互动小说做章末档案。玩家刚演完第 ${chapterNo} 章。这份档案之后每一章都会被读到，而且原文会被砍掉——它是那些事唯一的记录，所以要准、要全，不要好看。${fromText}

只输出 json，不要代码块、不要解释：
{"title":"这一章的名字，4–8 个字","period":"这一章的时间跨度，如 9月1日—9月4日","state":"这一章停在哪一步，40 字以内","events":[""],"scenes":[""]}

规则：
1. period 照正文里的 time 写，取这一章第一回合到最后一回合的日期；跨了几天就写区间，同一天就写那一天。日期不许省略。
2. state 只回答「这一章结束时停在哪一步」，一句话，40 字以内。不写过程，不总结主题，不抒情。例：「她答应下周陪丹恒去训练场，还没去。」
3. events 只记**会改变后面走向**的事：关系推进或倒退、立下的约定、交底或秘密、受伤与冲突、做出的决定、第一次做某事、得到或失去重要的东西。日常小动作（递水、换药、寒暄、让座、擦汗）一律不写；真实发生过但删掉也不影响后续的，也不写。条数按重要性筛，通常 8–20 条，按发生顺序。每条 60 字以内，**必须以日期开头**，格式是「9月1日 · 谁对谁做了什么，说了什么要点，结果如何」。
4. 判断标准一句话：这件事删掉，下一章会不会出问题？会，就写；不会，就不写。原文明写的细节（谁在场、谁递给谁什么、谁没说话）只在重要事件里带一句，不是给每个动作记账。
5. 下面这几类必须单独成条，不许并进别的条目：答应下来的事与约定（谁约谁、约在哪天）、送出去或借来的东西、说出口的秘密或交底、称呼的变化（第一次叫名字、第一次用只有两个人知道的叫法）、第一次做的事（第一次单独相处、第一次牵手、第一次吃醋摆在明面上）。
6. 环境、天气、心情不进 events；它们只在和事件绑在一起时才提一句。
7. scenes 最多 3 条，只写文本里确实铺垫过、还没发生的场面；没有就给 []。
8. 人物用设定里的名字，不用「他」「那个女孩」代替。
9. 已经发生过的事不要写成「即将发生」。
10. 年级、年龄、身份照人物表写。正文里写错的地方不要抄进档案，宁可不提；档案会被后面每一章读到，写错一次就会一直错下去。
11. 用简体中文。

${worldContext(world, 1200)}`;
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `这一章的正文：\n\n${transcript}` },
  ];
}

export function characterByName(world: World, name?: string): Character | undefined {
  if (!name) return undefined;
  const clean = (s: string) => s.trim().replace(/[「」“”"'·・\s]/g, "");
  const n = clean(name);
  if (!n) return undefined;
  const exact = world.characters.find((c) => clean(c.name) === n);
  if (exact) return exact;
  if (n.length < 2) return undefined;
  // 模型有时写「阿绫小姐」或只写名，按包含关系再对一次
  return world.characters.find((c) => {
    const cn = clean(c.name);
    return cn.length >= 2 && (n.includes(cn) || cn.includes(n));
  });
}

// 把档案模型吐出来的 JSON 收成 ChapterArchive。章末自动归档和「重写本章档案」都走这里，
// 免得两处字段限制不一致。解析不了、或者没写 state，就返回 null 让调用方放弃。
export function parseArchive(raw: string): ChapterArchive | null {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const state = String(j.state || j.summary || "").trim().slice(0, 80);
  if (!state) return null;
  const events = Array.isArray(j.events)
    ? j.events
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 100))
        .slice(0, 60)
    : [];
  const scenes = Array.isArray(j.scenes)
    ? j.scenes
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 80))
        .slice(0, 3)
    : [];
  return {
    title: String(j.title || "").trim().slice(0, 16),
    state,
    summary: state,
    period: String(j.period || "").trim().slice(0, 40),
    events,
    scenes,
  };
}
