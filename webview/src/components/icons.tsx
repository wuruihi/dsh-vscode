/**
 * Line-icon set — ported from the MIT-licensed DeepSeek-Harness-for-VS-Code
 * (github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code, media/chat.css ICONS
 * table, v0.12.90). Stroke-based, 24×24 viewport, inherits currentColor so
 * light/dark themes both work without per-icon colors.
 */
import { memo } from "react";

const ICONS: Record<string, string> = {
  // 复制
  copy: "M9 11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z|M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  // 点赞 / 点踩
  up: "M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z|M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3",
  down: "M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17",
  // 产物(盒子)
  box: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z|M3.27 6.96 12 12.01l8.73-5.05|M12 22.08V12",
  // 分支(↪)
  branch: "M6 3v12|M18 9a9 9 0 0 1-9 9|M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M18 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  // 回退(逆时针)
  rewind: "M1 4v6h6|M3.51 15a9 9 0 1 0 2.13-9.36L1 10",
  // 分支并回退(向左上)
  corner: "M9 14 4 9l5-5|M20 20v-7a4 4 0 0 0-4-4H4",
  // 回到主线(左上箭头)
  backMain: "M17 17 7 7|M7 17V7h10",
  // 斜杠(命令输入)
  slash: "M7 17 17 7",
  // 加号 / 更多 / 地球 / 发送 / 停止
  plus: "M12 5v14|M5 12h14",
  more: "M12 12h.01|M19 12h.01|M5 12h.01",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  send: "M22 2 11 13|M22 2 15 22l-4-9-9-4z",
  stop: "M6 6h12v12H6z",
  // 工作区 / 任务 / 轨迹 / 设置 / 搜索
  list: "M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01",
  ledger: "M4 4h16v16H4z|M8 8h8|M8 12h8|M8 16h5",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  search: "M21 21l-4.35-4.35|M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z",
  up2: "M12 19V5|M5 12l7-7 7 7",
  down2: "M12 5v14|M19 12l-7 7-7-7",
  x: "M18 6 6 18|M6 6l12 12",
  edit: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  trash: "M3 6h18|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  back: "M19 12H5|M12 19l-7-7 7-7",
  image: "M3 5h18v14H3z|M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z|M21 15l-5-5L5 21",
  // 提问(帮助圆圈)
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3|M12 17h.01",
  // 勾选(多选复选框选中态)
  check: "M20 6 9 17l-5-5",
  // 信息(圆圈 i)
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-4|M12 8h.01",
};

export type IconName = keyof typeof ICONS;

export const Icon = memo(function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none", display: "inline-block", verticalAlign: "-2px" }}
    >
      {paths.split("|").map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
});
