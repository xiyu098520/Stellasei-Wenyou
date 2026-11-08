export type Block = {
  id: string;
  title: string;
  content: string;
};

export type Field = {
  k: string;
  v: string;
};

export type Character = {
  id: string;
  name: string;
  identity: string;
  speech: string;
  voiceId: string;
  avatar?: string;
  fields: Field[];
};

export type Note = {
  id: string;
  title: string;
  content: string;
};

export type World = {
  id: string;
  version: 1;
  title: string;
  hasSource: boolean;
  sourceTitle: string;
  summary: string;
  protagonist?: string;
  notes?: Note[];
  blocks: Block[];
  characters: Character[];
  cover?: string;
  createdAt: number;
  updatedAt: number;
};

export type Segment = {
  type: "narration" | "action" | "line";
  speaker?: string;
  // 这一句的语气标记，如 [sighs]，只在 eleven v3 及以后合成时才带上
  tone?: string;
  text: string;
  // 不当面来的消息（短信、终端、广播）写渠道名；当面说话没有这个字段
  via?: string;
  // 台词念出来的日文版；配音语言选日文时用它，正文照旧显示 text
  ja?: string;
};

// 这一回合结束时的舞台：在哪、什么天气、身边看得见谁、主角什么样
export type Stage = {
  place?: string;
  weather?: string;
  present?: string[];
  look?: string;
};

// 这一回合真正拿到手的东西
export type Gained = {
  name: string;
  note?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  segments?: Segment[];
  options?: string[];
  // 这一回合结束时的舞台，没给就沿用上一回合
  stage?: Stage;
  // 给不在对话里的那一个人的镜头，只写看得见的动作
  aside?: string;
  gained?: Gained[];
  // 这一回合对下一场的设想：大概走到哪、可能碰到谁。只是打算，走向变了就作废
  plan?: { scene: string; cast: string[] };
  at: number;
};

export type Relation = {
  a: string;
  b: string;
  // 亲密度档位 L0–L5：初识、熟悉、感到兴趣、确认自己心意、追求／布局／引导、私下恋情／队内公开
  level?: number;
  state: string;
};

export type ChapterArchive = {
  title: string;
  // 这一章结束时停在哪一步，一句话。旧存档只有 summary，读的时候按 state 退回
  state?: string;
  summary: string;
  events: string[];
  // 这一章的时间跨度，如「九月一日—九月四日」
  period?: string;
  // 这一章结束时的关系定格，后面每章都读得到
  relations?: Relation[];
  scenes: string[];
};

export type Save = {
  worldId: string;
  messages: Message[];
  // 开场时玩家自己写的那句话，重写第一回合要用它，清空后也留着
  seed?: string;
  // 序章：第一幕的背景，只在第一回合用一次。可以写很长，交给模型铺场面，
  // 之后它变成正文留在历史里，不用每回合再带一遍
  prologue?: string;
  chapterTitle: string;
  chapterTitles?: string[];
  recaps?: string[];
  archive?: ChapterArchive[];
  relations?: Relation[];
  memo?: string;
  // 故事里的现在：日期、星期、时段，由模型每回合往前推
  clock?: string;
  // 每章第一回合的时间，索引就是章号；章末档案要写日期区间，得知道从哪天开始
  clocks?: string[];
  // 已经整章砍掉的回合数。章号还是按「总回合 ÷ 24」算，所以必须记这一笔
  droppedTurns?: number;
  // 砍掉的原文按章存着：只给玩家回看，不进提示词、不许改。索引就是章号
  buried?: Message[][];
  // 现在的舞台，主角一进游戏就能看见自己在哪、身边有谁
  stage?: Stage;
  threads: string[];
  updatedAt: number;
};

export const CHAPTER_TURNS = 24;

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function emptySave(worldId: string): Save {
  return {
    worldId,
    messages: [],
    chapterTitle: "序章",
    chapterTitles: [],
    recaps: [],
    threads: [],
    updatedAt: Date.now(),
  };
}

export function defaultBlocks(): Block[] {
  return [
    { id: newId(), title: "世界总览", content: "" },
    { id: newId(), title: "地点", content: "" },
    { id: newId(), title: "文风", content: "" },
  ];
}

export function turnsOf(save: Save) {
  // 老章砍掉之后原文不在了，回合数要接上被砍的那部分，章号才不会退回去
  return save.messages.filter((m) => m.role === "user").length + (save.droppedTurns || 0);
}

export function chapterNo(save: Save) {
  return Math.floor(turnsOf(save) / CHAPTER_TURNS) + 1;
}

const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function chapterTitleOf(save: Save, n: number) {
  const t = save.chapterTitles?.[n - 1]?.trim();
  if (t) return t;
  if (n === 1 && save.chapterTitle && save.chapterTitle !== "序章") return save.chapterTitle;
  return "";
}

export function chapterLabel(save: Save) {
  if (turnsOf(save) === 0) return "序章";
  const n = chapterNo(save);
  const num = n <= 10 ? CN[n - 1] : String(n);
  const title = chapterTitleOf(save, n);
  return title ? `第${num}章 · ${title}` : `第${num}章`;
}
