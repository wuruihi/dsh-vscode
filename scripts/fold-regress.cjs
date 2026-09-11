/**
 * fold-regress.cjs — fold correctness against REAL wire shapes.
 *
 * Fixture events replicate probed rc.2/alpha.5 shapes exactly:
 *  - assistant/chunk {data:{chunk:{type:text-delta|reasoning-delta}}}
 *  - tool/call with TOP-LEVEL data.callId
 *  - tool/result with the callId NESTED at data.message.source.callId and
 *    data.message.content[0].toolCallId, text nested one level deeper
 *    (content[0].content[0].text) — the shape that left every activity
 *    spinning forever before the fix
 *  - persistent step/start|end {turn, step}
 *
 * Asserts: no stuck-running activities, segments interleaved in arrival
 * order, flat text/thinking views stay synced, nested preview extracted.
 */
const { buildSync } = require("esbuild");
const path = require("path");
const os = require("os");

const out = path.join(os.tmpdir(), `fold-regress-${Date.now()}.cjs`);
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "fold.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { ConversationFold } = require(out);

let seq = 100;
const ev = (type, data) => ({ event: { type, seq: ++seq, time: Date.now(), data } });
const chunk = (c) => ev("assistant/chunk", { turn: 1, step: 1, chunk: c });

const entries = [
  ev("user/message", { content: [{ type: "text", text: "改一下这个文件" }] }),
  ev("turn/start", { turn: 1 }),
  chunk({ type: "block-start", index: 0, blockType: "reasoning" }),
  chunk({ type: "reasoning-delta", index: 0, text: "想想" }),
  chunk({ type: "reasoning-delta", index: 0, text: "怎么改" }),
  chunk({ type: "text-delta", index: 1, text: "先看文件内容。" }),
  // HISTORY-REPLAY form (session/page): prose rides chunkrow rows, not deltas
  ev("chunkrow/reasoning-chunks", { turn: 1, step: 1, index: 0, texts: ["历史", "思考"] }),
  ev("chunkrow/text-chunks", { turn: 1, step: 1, index: 1, texts: ["历史正文", "一段。"] }),
  ev("tool/call", { turn: 1, step: 2, callId: "call_read1", name: "read", arguments: '{"path":"a.ts"}' }),
  ev("tool/result", {
    turn: 1,
    step: 2,
    message: {
      source: { kind: "tool", callId: "call_read1" },
      content: [
        {
          type: "tool-result",
          toolCallId: "call_read1",
          content: [{ type: "text", text: "文件内容 ABC" }],
          isError: false,
        },
      ],
    },
  }),
  chunk({ type: "reasoning-delta", index: 0, text: "想好了" }),
  chunk({ type: "text-delta", index: 1, text: "现在开始编辑。" }),
  ev("step/start", { turn: 1, step: 3 }),
  ev("tool/call", { turn: 1, step: 3, callId: "call_edit1", name: "edit", arguments: '{"path":"a.ts"}' }),
  ev("tool/result", {
    turn: 1,
    step: 3,
    message: {
      source: { kind: "tool", callId: "call_edit1" },
      content: [
        {
          type: "tool-result",
          toolCallId: "call_edit1",
          content: [{ type: "text", text: "The file a.ts has been updated." }],
          isError: false,
        },
      ],
    },
  }),
  ev("step/end", { turn: 1, step: 3 }),
  chunk({ type: "text-delta", index: 1, text: "完成了。" }),
  ev("turn/end", { turn: 1 }),
];

const fold = new ConversationFold();
fold.pushMany(entries);

const fails = [];
let passed = 0;
const ok = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (cond) passed++;
  else fails.push(name);
};

const turns = fold.items.filter((i) => i.kind === "turn");
const turn = turns[0];

// 1. no activity left running (the perpetual-spinner bug)
ok("no stuck-running activities (nested callId resolved)", turn.activities.every((a) => a.state !== "running"));
ok("read tool state = done", turn.activities.find((a) => a.key === "call_read1")?.state === "done");
ok("edit tool state = done", turn.activities.find((a) => a.key === "call_edit1")?.state === "done");

// 2. nested preview extracted
ok(
  "nested result preview extracted",
  turn.activities.find((a) => a.key === "call_read1")?.resultPreview === "文件内容 ABC",
);

// 3. segments interleaved in TRUE arrival order (incl. chunkrow history rows)
const order = turn.segments.map((s) => s.kind).join(",");
ok(
  "segments interleaved (think,text,crowT,crowX,tool,think,text,step,edit,text)",
  order === "thinking,text,thinking,text,tool,thinking,text,tool,tool,text",
);

// 4. flat views stay synced (chunkrow included)
ok("flat text synced (deltas + chunkrow)", turn.text === "先看文件内容。历史正文一段。现在开始编辑。完成了。");
ok("flat thinking synced (deltas + chunkrow)", turn.thinking === "想想怎么改历史思考想好了");
ok("activities count = 3 (read/edit/step)", turn.activities.length === 3);

// 5. legacy top-level tool/result shape still resolves
const fold2 = new ConversationFold();
fold2.pushMany([
  ev("turn/start", { turn: 1 }),
  ev("tool/call", { turn: 1, step: 1, callId: "call_x", name: "pwsh", arguments: "{}" }),
  ev("tool/result", { turn: 1, step: 1, callId: "call_x", isError: true }),
  ev("turn/end", { turn: 1 }),
]);
const t2 = fold2.items.find((i) => i.kind === "turn");
ok("legacy top-level result shape resolves + error state", t2.activities[0]?.state === "error");

// 6. REPLAY-SHAPE PROSE (badcase): assistant/message carries content as an
//    ARRAY of blocks; text-delta chunks are NOT persisted, so prose arrives
//    only here. The old fold read `content` as a string and dropped every
//    replayed answer — the panel showed tool steps with no text at all.
//    Verbatim tail of "洛阳案件分析模块需求分析" (session-d75a304a), 254 chars.
const FINAL_TEXT = `规则已更新完毕：

- \`rules_demo\` §4 重写为 **filter-table 两行表格式**：搜索条件行（文本输入类）/ 更多筛选行（时间/下拉/级联/范围类），全部平铺不用折叠，操作按钮放 \`.filter-table-actions\`；旧 filter-row 展开收起式标注为仅存量页面保留
- frontmatter description 同步（“筛选展开收起”→“筛选filter-table两行式”）
- 当日日志已记

此后所有新 demo 页面默认按这个筛选样式走。

以上`;

const replay = new ConversationFold();
replay.pushMany([
  ev("turn/start", { turn: 19, step: 5 }),
  ev("assistant/message", { turn: 19, step: 5, message: { content: [{ type: "reasoning", text: "先读规则文件" }, { type: "tool-call", toolName: "edit" }] } }),
  ev("tool/call", { turn: 19, step: 5, callId: "call_replay", name: "edit", arguments: '{"file_path":"memory/2026-09-08.md"}' }),
  ev("tool/result", { turn: 19, step: 5, callId: "call_replay" }),
  ev("step/end", { turn: 19, step: 5 }),
  ev("assistant/message", { turn: 19, step: 5, message: { content: [{ type: "text", text: FINAL_TEXT }] } }),
  ev("turn/end", { turn: 19 }),
]);
const rt = replay.items.filter((i) => i.kind === "turn")[0];
ok("replayed array-content prose renders (badcase)", rt.text.includes("规则已更新完毕"));
ok("replayed reply keeps its tail (…以上)", rt.text.trimEnd().endsWith("以上"));
ok("replayed reasoning block also renders", rt.thinking.includes("先读规则文件"));
ok("tool-call block not duplicated as text", !rt.text.includes("toolName"));

// 7. live deltas + the completed message for the SAME step: one copy only
const live = new ConversationFold();
live.pushMany([
  ev("turn/start", { turn: 1, step: 1 }),
  ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", text: "规则已更新" } }),
  ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", text: "完毕：" } }),
  ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "规则已更新完毕：" }] } }),
  ev("turn/end", { turn: 1 }),
]);
ok("live deltas + message do not double the prose", live.items.find((i) => i.kind === "turn").text === "规则已更新完毕：");

// 8. identical text in DIFFERENT steps is legitimate and must survive
const rep = new ConversationFold();
rep.pushMany([
  ev("turn/start", { turn: 1, step: 1 }),
  ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "好的。" }] } }),
  ev("assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "好的。" }] } }),
  ev("turn/end", { turn: 1 }),
]);
ok("repeated text across steps kept", rep.items.find((i) => i.kind === "turn").text === "好的。好的。");

// 9. interleaving preserved when prose comes from messages, not deltas
const mix = new ConversationFold();
mix.pushMany([
  ev("turn/start", { turn: 1, step: 1 }),
  ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "甲" }] } }),
  ev("tool/call", { turn: 1, step: 2, callId: "c1", name: "pwsh", arguments: '{"command":"ls"}' }),
  ev("assistant/message", { turn: 1, step: 3, message: { content: [{ type: "text", text: "乙" }] } }),
  ev("turn/end", { turn: 1 }),
]);
ok("message-prose interleaves with tools", mix.items.find((i) => i.kind === "turn").segments.map((s) => s.kind).join(">") === "text>tool>text");

// 10. legacy string-form message still renders (old hosts)
const str = new ConversationFold();
str.pushMany([
  ev("turn/start", { turn: 1, step: 1 }),
  ev("assistant/message", { turn: 1, step: 1, message: { content: "纯文本" } }),
  ev("turn/end", { turn: 1 }),
]);
ok("string-form message still renders", str.items.find((i) => i.kind === "turn").text === "纯文本");

console.log(fails.length === 0 ? `\n${passed}/${passed} passed` : `\nFAILED: ${fails.length}`);
process.exit(fails.length === 0 ? 0 : 1);
