// 模型回的 JSON 常常带代码块、前后多话、字符串里有没转义的换行，逐个兜

export function repairJson(s: string) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        /* 丢掉 */
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

// 输出被截断时：把没收尾的字符串、括号补齐，至少把写完的段落救回来
export function closeJson(s: string) {
  let out = "";
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
    out += ch;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) {
    out += stack.pop() === "{" ? "}" : "]";
  }
  return out;
}

export function pullJson(raw: string): Record<string, unknown> | null {
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0) return null;
  const body = b > a ? t.slice(a, b + 1) : "";
  const tail = t.slice(a);
  const cands = [body, repairJson(body), closeJson(body), repairJson(closeJson(body))];
  if (tail !== body) cands.push(repairJson(closeJson(tail)), closeJson(tail));
  for (const cand of cands) {
    if (!cand.trim()) continue;
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === "object") return j as Record<string, unknown>;
    } catch {
      /* 换一种修法再试 */
    }
  }
  return null;
}

// 回复偶尔会从段落中间开始（开头那句 {"segments":[ 丢了），或者整体被截断。
// 把外壳补回来再解析，能连 options、threads 一起救回，这一回合就不用重写了
const SEG_TYPE = /"type"\s*:\s*"(?:narration|action|line)"/;

export function pullLoose(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  const m = t.search(SEG_TYPE);
  if (m < 0) return null;
  const body = t.slice(Math.max(0, t.lastIndexOf("{", m)));
  const cands = [`{"segments":[${body}`, `{"segments":[${body}]}`, `{${body}`, body];
  for (const c of cands) {
    for (const x of [c, repairJson(c), closeJson(c), repairJson(closeJson(c))]) {
      try {
        const j = JSON.parse(x);
        if (j && typeof j === "object" && Array.isArray((j as Record<string, unknown>).segments)) {
          return j as Record<string, unknown>;
        }
      } catch {
        /* 换一种补法 */
      }
    }
  }
  return null;
}

// 连壳都补不回来时，逐个把写完的段落对象扫出来，至少这一回合读得下去
export function pullSegments(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = new RegExp(SEG_TYPE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = raw.lastIndexOf("{", m.index);
    if (start < 0) continue;
    let inStr = false;
    let esc = false;
    let depth = 0;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const slice = end > start ? raw.slice(start, end + 1) : raw.slice(start);
    for (const x of [slice, closeJson(slice), repairJson(closeJson(slice))]) {
      try {
        const j = JSON.parse(x) as { text?: unknown };
        if (j && typeof j === "object" && typeof j.text === "string" && j.text.trim()) {
          out.push(j as Record<string, unknown>);
          break;
        }
      } catch {
        /* 下一段 */
      }
    }
    re.lastIndex = Math.max(re.lastIndex, end > start ? end + 1 : re.lastIndex);
  }
  return out;
}

// 只救段落时，顺手把 options 这类字符串数组也捞出来
export function pullStrings(raw: string, key: string): string[] {
  const i = raw.indexOf(`"${key}"`);
  if (i < 0) return [];
  const a = raw.indexOf("[", i);
  if (a < 0) return [];
  const b = raw.indexOf("]", a);
  const slice = raw.slice(a, b > a ? b + 1 : a + 1);
  for (const x of [slice, closeJson(slice), repairJson(closeJson(slice))]) {
    try {
      const arr = JSON.parse(x);
      if (Array.isArray(arr)) {
        return arr.filter((v): v is string => typeof v === "string" && !!v.trim()).slice(0, 3);
      }
    } catch {
      /* 换一种补法 */
    }
  }
  return [];
}

// 实在解析不出来时，至少把「say」里的那句话捞出来
export function pullSay(raw: string) {
  const m = raw.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try {
    return String(JSON.parse(`"${m[1]}"`)).trim();
  } catch {
    return m[1].trim();
  }
}
