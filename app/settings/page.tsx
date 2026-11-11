"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadSettings, saveSettings, Settings, ModelPreset } from "@/lib/settings";
import { newId } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

type Status = { kind: "idle" | "busy" | "ok" | "bad"; text: string };

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [astatus, setAstatus] = useState<Status>({ kind: "idle", text: "" });
  const [vstatus, setVstatus] = useState<Status>({ kind: "idle", text: "" });
  const [sstatus, setSstatus] = useState<Status>({ kind: "idle", text: "" });
  const [tmodels, setTmodels] = useState<string[]>([]);
  const [amodels, setAmodels] = useState<string[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [vmodels, setVmodels] = useState<{ id: string; name: string }[]>([]);
  const [fetching, setFetching] = useState<"" | "text" | "assistant" | "voice" | "vomodel">("");
  const [fetchErr, setFetchErr] = useState<{ at: string; msg: string } | null>(null);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    setS(loadSettings());
  }, []);

  function updateText(patch: Partial<Settings["text"]>) {
    if (!s) return;
    const next: Settings = { ...s, text: { ...s.text, ...patch } };
    setS(next);
    saveSettings(next);
    setStatus({ kind: "idle", text: "" });
  }

  // 把眼下这套地址 + 模型 + Key 存成一个名字；同名就覆盖
  function savePreset() {
    if (!s) return;
    const name = presetName.trim() || s.text.model.trim();
    if (!name) return;
    const list = [...(s.presets || [])];
    const at = list.findIndex((p) => p.name === name);
    const item: ModelPreset = {
      id: list[at]?.id || newId(),
      name,
      baseUrl: s.text.baseUrl,
      model: s.text.model,
      apiKey: s.text.apiKey,
    };
    if (at >= 0) list[at] = item;
    else list.push(item);
    const next: Settings = { ...s, presets: list };
    setS(next);
    saveSettings(next);
    setPresetName("");
  }

  function applyPreset(p: ModelPreset) {
    if (!s) return;
    const next: Settings = {
      ...s,
      text: { ...s.text, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey },
    };
    setS(next);
    saveSettings(next);
    setStatus({ kind: "idle", text: "" });
  }

  function dropPreset(id: string) {
    if (!s) return;
    const next: Settings = { ...s, presets: (s.presets || []).filter((p) => p.id !== id) };
    setS(next);
    saveSettings(next);
  }

  function updateAssistant(patch: Partial<Settings["assistant"]>) {
    if (!s) return;
    const next: Settings = { ...s, assistant: { ...s.assistant, ...patch } };
    setS(next);
    saveSettings(next);
    setAstatus({ kind: "idle", text: "" });
  }

  function updateVoice(patch: Partial<Settings["voice"]>) {
    if (!s) return;
    const next: Settings = { ...s, voice: { ...s.voice, ...patch } };
    setS(next);
    saveSettings(next);
    setVstatus({ kind: "idle", text: "" });
  }

  async function pingVoice(cfg: Settings["voice"], set: (st: Status) => void) {
    if (!cfg.apiKey.trim()) {
      set({ kind: "bad", text: "先填 Key" });
      return;
    }
    const voiceId = cfg.defaultVoiceId.trim() || "21m00Tcm4TlvDq8ikWAM";
    set({ kind: "busy", text: "在读" });
    try {
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: cfg.apiKey,
          voiceId,
          text: `${
            /v[3-9]/i.test(cfg.model) && cfg.tone?.trim() ? `${cfg.tone.trim()} ` : ""
          }${
            // 选日文就用日文试听，不然听不出切换有没有生效
            cfg.lang === "ja"
              ? "灯りはついたまま。戸は閉めておいたから、戻ったら足音を小さくね。"
              : "灯还亮着，我把门关上了。你回来的时候，脚步轻一点。"
          }`,
          model: cfg.model,
          speed: cfg.speed,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "连接失败");
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await audio.play();
      set({ kind: "ok", text: "出声了" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "连接失败";
      set({
        kind: "bad",
        text: msg.includes("401")
          ? "Key 不对"
          : msg.includes("402") || msg.includes("quota")
            ? "额度不够"
            : msg.includes("404")
              ? "音色 ID 不对"
              : "连接失败",
      });
    }
  }

  async function pingSearch(cfg: Settings["search"], set: (st: Status) => void) {
    if (!cfg.apiKey.trim()) {
      set({ kind: "bad", text: "先填 Key" });
      return;
    }
    set({ kind: "busy", text: "在查" });
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: cfg.provider, apiKey: cfg.apiKey, query: "文游" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "连接失败");
      set({ kind: "ok", text: `查回 ${data?.results?.length || 0} 条` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "连接失败";
      set({
        kind: "bad",
        text: msg.includes("401") || msg.includes("403") ? "Key 不对" : msg.includes("429") ? "查太快了" : "连接失败",
      });
    }
  }

  function updateSearch(patch: Partial<Settings["search"]>) {
    if (!s) return;
    const next: Settings = { ...s, search: { ...s.search, ...patch } };
    setS(next);
    saveSettings(next);
    setSstatus({ kind: "idle", text: "" });
  }

  async function loadModels(which: "text" | "assistant") {
    if (!s) return;
    const cfg = which === "text" ? s.text : s.assistant;
    if (!cfg.baseUrl.trim()) {
      setFetchErr({ at: which, msg: "先填地址" });
      return;
    }
    if (!cfg.apiKey.trim()) {
      setFetchErr({ at: which, msg: "先填 Key" });
      return;
    }
    setFetching(which);
    setFetchErr(null);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "取不到模型");
      const list: string[] = data?.models || [];
      if (which === "text") setTmodels(list);
      else setAmodels(list);
    } catch (e) {
      setFetchErr({ at: which, msg: e instanceof Error ? e.message : "取不到模型" });
    } finally {
      setFetching("");
    }
  }

  async function loadVoices() {
    if (!s) return;
    if (!s.voice.apiKey.trim()) {
      setFetchErr({ at: "voice", msg: "先填 Key" });
      return;
    }
    setFetching("voice");
    setFetchErr(null);
    try {
      const res = await fetch("/api/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: s.voice.apiKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "取不到音色");
      setVoices(data?.voices || []);
    } catch (e) {
      setFetchErr({ at: "voice", msg: e instanceof Error ? e.message : "取不到音色" });
    } finally {
      setFetching("");
    }
  }

  async function loadVmodels() {
    if (!s) return;
    if (!s.voice.apiKey.trim()) {
      setFetchErr({ at: "vomodel", msg: "先填 Key" });
      return;
    }
    setFetching("vomodel");
    setFetchErr(null);
    try {
      const res = await fetch("/api/voicemodels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: s.voice.apiKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "取不到模型");
      setVmodels(data?.models || []);
    } catch (e) {
      setFetchErr({ at: "vomodel", msg: e instanceof Error ? e.message : "取不到模型" });
    } finally {
      setFetching("");
    }
  }

  async function ping(cfg: Settings["text"], set: (st: Status) => void) {
    if (!cfg.apiKey.trim()) {
      set({ kind: "bad", text: "先填 Key" });
      return;
    }
    set({ kind: "busy", text: "在试" });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages: [{ role: "user", content: "只回两个字：收到" }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "连接失败");
      set({ kind: "ok", text: "正常" });
    } catch (e) {
      set({ kind: "bad", text: e instanceof Error ? e.message : "连接失败" });
    }
  }

  if (!s) {
    return (
      <main className="page">
        <div className="loading">正在翻开</div>
      </main>
    );
  }

  const textOn = Boolean(s.text.apiKey.trim());
  const assistantOn = Boolean(s.assistant.apiKey.trim());
  const voiceOn = Boolean(s.voice.apiKey.trim());
  const searchOn = Boolean(s.search.apiKey.trim());
  const cls = (st: Status) =>
    st.kind === "ok" ? "statustext ok" : st.kind === "bad" ? "statustext bad" : "statustext";

  return (
    <main className="page">
      <div className="topbar">
        <Link className="where" href="/">
          <u>‹</u>我的世界
        </Link>
      </div>

      <div className="mastline" style={{ marginTop: 22 }} />
      <div className="topline">
        <h1>设置</h1>
        <div className="right">
          <span>本机</span>
        </div>
      </div>

      <p className="setintro">Key 存在本机，不进剧本文件。</p>

      <section className="sec">
        <div className="sec-h">
          <i>01</i>
          <b>剧情</b>
          <em className={textOn ? "on" : ""}>{textOn ? "已接" : "未接"}</em>
        </div>
        <div className="frow">
          <span className="k">服务商</span>
          <span className="v">自定义</span>
        </div>
        <div className="frow">
          <span className="k">地址</span>
          <input
            className="v mono"
            value={s.text.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            onChange={(e) => updateText({ baseUrl: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">模型</span>
          <input
            className="v mono"
            value={s.text.model}
            placeholder="deepseek-chat"
            spellCheck={false}
            onChange={(e) => updateText({ model: e.target.value })}
          />
          <span className="statustext">{tmodels.length ? `共 ${tmodels.length}` : ""}</span>
          <button type="button" onClick={() => loadModels("text")} disabled={fetching === "text"}>
            {fetching === "text" ? "取…" : "取列表"}
          </button>
        </div>
        {tmodels.length > 0 && (
          <div className="mchips">
            {tmodels.map((m) => (
              <button
                type="button"
                key={m}
                className={m === s.text.model ? "on" : ""}
                onClick={() => updateText({ model: m })}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {fetchErr?.at === "text" && <p className="fetcherr">{fetchErr.msg}</p>}
        <div className="frow">
          <span className="k">Key</span>
          <input
            className="v mono"
            type="password"
            value={s.text.apiKey}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => updateText({ apiKey: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">连接</span>
          <span className={cls(status)}>{status.text || "还没测"}</span>
          <button
            type="button"
            onClick={() => ping(s.text, setStatus)}
            disabled={status.kind === "busy"}
          >
            测一下
          </button>
        </div>
        <div className="frow">
          <span className="k">预设</span>
          <input
            className="v"
            value={presetName}
            placeholder="给这套配置起个名，如「好文笔」"
            onChange={(e) => setPresetName(e.target.value)}
          />
          <button type="button" onClick={savePreset}>
            存下
          </button>
        </div>
        {(s.presets?.length ?? 0) > 0 && (
          <div className="mchips">
            {s.presets!.map((p) => (
              <button
                type="button"
                key={p.id}
                className={p.model === s.text.model && p.baseUrl === s.text.baseUrl ? "on" : ""}
                onClick={() => applyPreset(p)}
                title={`${p.baseUrl}｜${p.model}`}
              >
                {p.name}
                <i
                  className="x"
                  onClick={(e) => {
                    e.stopPropagation();
                    dropPreset(p.id);
                  }}
                >
                  ×
                </i>
              </button>
            ))}
          </div>
        )}
        <p className="sec-note">开演时，演这个世界的用它。</p>
      </section>

      <section className="sec">
        <div className="sec-h">
          <i>02</i>
          <b>助手</b>
          <em className={assistantOn ? "on" : ""}>{assistantOn ? "已接" : "未接"}</em>
        </div>
        <div className="frow">
          <span className="k">服务商</span>
          <span className="v">自定义</span>
        </div>
        <div className="frow">
          <span className="k">地址</span>
          <input
            className="v mono"
            value={s.assistant.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            onChange={(e) => updateAssistant({ baseUrl: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">模型</span>
          <input
            className="v mono"
            value={s.assistant.model}
            placeholder="deepseek-chat"
            spellCheck={false}
            onChange={(e) => updateAssistant({ model: e.target.value })}
          />
          <span className="statustext">{amodels.length ? `共 ${amodels.length}` : ""}</span>
          <button
            type="button"
            onClick={() => loadModels("assistant")}
            disabled={fetching === "assistant"}
          >
            {fetching === "assistant" ? "取…" : "取列表"}
          </button>
        </div>
        {amodels.length > 0 && (
          <div className="mchips">
            {amodels.map((m) => (
              <button
                type="button"
                key={m}
                className={m === s.assistant.model ? "on" : ""}
                onClick={() => updateAssistant({ model: m })}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {fetchErr?.at === "assistant" && <p className="fetcherr">{fetchErr.msg}</p>}
        <div className="frow">
          <span className="k">Key</span>
          <input
            className="v mono"
            type="password"
            value={s.assistant.apiKey}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => updateAssistant({ apiKey: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">连接</span>
          <span className={cls(astatus)}>{astatus.text || "还没测"}</span>
          <button
            type="button"
            onClick={() => ping(s.assistant, setAstatus)}
            disabled={astatus.kind === "busy"}
          >
            测一下
          </button>
        </div>
        <p className="sec-note">写设定、挑联网资料时用它，跟剧情分开算。</p>
      </section>

      <section className="sec">
        <div className="sec-h">
          <i>03</i>
          <b>语音</b>
          <em className={voiceOn ? "on" : ""}>{voiceOn ? "已接" : "未接"}</em>
        </div>
        <div className="frow">
          <span className="k">服务商</span>
          <span className="v">ElevenLabs</span>
        </div>
        <div className="frow">
          <span className="k">Key</span>
          <input
            className="v mono"
            type="password"
            value={s.voice.apiKey}
            placeholder="sk_…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => updateVoice({ apiKey: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">默认音色</span>
          <input
            className="v mono"
            value={s.voice.defaultVoiceId}
            placeholder="21m00Tcm4TlvDq8ikWAM"
            spellCheck={false}
            onChange={(e) => updateVoice({ defaultVoiceId: e.target.value })}
          />
          <button type="button" onClick={loadVoices} disabled={fetching === "voice"}>
            {fetching === "voice" ? "取…" : "取音色"}
          </button>
        </div>
        {voices.length > 0 && (
          <div className="mchips">
            {voices.map((v) => (
              <button
                type="button"
                key={v.id}
                className={v.id === s.voice.defaultVoiceId ? "on" : ""}
                title={v.id}
                onClick={() => updateVoice({ defaultVoiceId: v.id })}
              >
                {v.name}
              </button>
            ))}
          </div>
        )}
        {fetchErr?.at === "voice" && <p className="fetcherr">{fetchErr.msg}</p>}
        <div className="frow">
          <span className="k">模型</span>
          <div className="segmini">
            {[
              { v: "eleven_multilingual_v2", t: "多语 v2" },
              { v: "eleven_turbo_v2_5", t: "Turbo" },
              { v: "eleven_flash_v2_5", t: "Flash" },
              { v: "eleven_v3", t: "v3" },
            ].map((m) => (
              <button
                type="button"
                key={m.v}
                className={s.voice.model === m.v ? "on" : ""}
                onClick={() => updateVoice({ model: m.v })}
              >
                {m.t}
              </button>
            ))}
          </div>
        </div>
        <div className="frow">
          <span className="k">更多</span>
          <span className="v" style={{ color: "var(--ink-4)" }}>账号里能用的</span>
          <button type="button" onClick={loadVmodels} disabled={fetching === "vomodel"}>
            {fetching === "vomodel" ? "取…" : "取模型"}
          </button>
        </div>
        {vmodels.length > 0 && (
          <div className="mchips">
            {vmodels.map((m) => (
              <button
                type="button"
                key={m.id}
                className={m.id === s.voice.model ? "on" : ""}
                title={m.id}
                onClick={() => updateVoice({ model: m.id })}
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
        {fetchErr?.at === "vomodel" && <p className="fetcherr">{fetchErr.msg}</p>}
        <div className="frow">
          <span className="k">语速</span>
          <div className="segmini">
            {[
              { v: 0.9, t: "慢" },
              { v: 1, t: "正常" },
              { v: 1.1, t: "快" },
            ].map((o) => (
              <button
                type="button"
                key={o.v}
                className={s.voice.speed === o.v ? "on" : ""}
                onClick={() => updateVoice({ speed: o.v })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>
        <div className="frow">
          <span className="k">配音语言</span>
          <div className="segmini">
            {[
              { v: "zh", t: "跟正文" },
              { v: "ja", t: "日文" },
            ].map((o) => (
              <button
                type="button"
                key={o.v}
                className={(s.voice.lang || "zh") === o.v ? "on" : ""}
                onClick={() => updateVoice({ lang: o.v === "ja" ? "ja" : "zh" })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>
        <div className="frow">
          <span className="k">试听语气</span>
          <input
            className="v mono"
            value={s.voice.tone || ""}
            placeholder="[sighs] / [whispers]，可留空"
            spellCheck={false}
            onChange={(e) => updateVoice({ tone: e.target.value })}
          />
        </div>
        {/* 常用的几个，点一下直接填进去 */}
        <div className="mchips">
          {["", "[sighs]", "[whispers]", "[laughs]", "[softly]", "[sad]", "[excited]", "[nervous]", "[pause]"].map(
            (t) => (
              <button
                type="button"
                key={t || "none"}
                className={(s.voice.tone || "") === t ? "on" : ""}
                onClick={() => updateVoice({ tone: t })}
              >
                {t || "不设"}
              </button>
            ),
          )}
        </div>
        <div className="frow">
          <span className="k">连接</span>
          <span className={cls(vstatus)}>{vstatus.text || "还没测"}</span>
          <button
            type="button"
            onClick={() => pingVoice(s.voice, setVstatus)}
            disabled={vstatus.kind === "busy"}
          >
            测一下
          </button>
        </div>
        <p className="sec-note">
          语气跟音色在 ElevenLabs 里存的设置一致，这里只调模型和语速。
          <br />
          这一栏只影响上面「测一下」，用来单独听音色；剧情里的台词由演出引擎按当时的情绪自己标，不套这里。
          <br />
          音色可在人物卡里单独填，没填就用默认。
        </p>
      </section>

      <section className="sec">
        <div className="sec-h">
          <i>04</i>
          <b>联网</b>
          <em className={searchOn ? "on" : ""}>{searchOn ? "已接" : "未接"}</em>
        </div>
        <div className="frow">
          <span className="k">服务商</span>
          <span className="segmini">
            <button
              type="button"
              className={s.search.provider === "bocha" ? "on" : ""}
              onClick={() => updateSearch({ provider: "bocha" })}
            >
              博查
            </button>
            <button
              type="button"
              className={s.search.provider === "tavily" ? "on" : ""}
              onClick={() => updateSearch({ provider: "tavily" })}
            >
              Tavily
            </button>
          </span>
        </div>
        <div className="frow">
          <span className="k">Key</span>
          <input
            className="v mono"
            type="password"
            value={s.search.apiKey}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => updateSearch({ apiKey: e.target.value })}
          />
        </div>
        <div className="frow">
          <span className="k">连接</span>
          <span className={cls(sstatus)}>{sstatus.text || "还没测"}</span>
          <button
            type="button"
            onClick={() => pingSearch(s.search, setSstatus)}
            disabled={sstatus.kind === "busy"}
          >
            测一下
          </button>
        </div>
        <p className="sec-note">
          设定页的「联网查原著」用它。
          <br />
          查回的条目要你点头才写进去。
        </p>
      </section>

      <section className="sec muted">
        <div className="sec-h">
          <i>05</i>
          <b>图片</b>
          <em>本机</em>
        </div>
        <div className="frow">
          <span className="k">用途</span>
          <span className="v">换封面，自己选图</span>
        </div>
      </section>

      <p className="setnote">Key 只存在这台设备上，不上传，换设备要重新填。</p>

      <div className="setfoot">
        <span>剧本与存档也在本机</span>
        <span>{APP_VERSION}</span>
      </div>
    </main>
  );
}
