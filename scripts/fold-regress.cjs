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

console.log(fails.length === 0 ? `\n${passed}/${passed} passed` : `\nFAILED: ${fails.length}`);
process.exit(fails.length === 0 ? 0 : 1);
