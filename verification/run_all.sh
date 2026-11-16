#!/bin/sh
# verification/run_all.sh
# 一键跑完所有离线验证（不需要微信开发者工具，不需要真机）。
#
# 用法：
#   sh verification/run_all.sh              # 缺依赖时：明确报出跳过项并**以失败退出**
#   ALLOW_SKIP=1 sh verification/run_all.sh # 缺依赖时：只告警，不判失败（本机自测用）
#
# 全部 13 步中，第 6~13 步依赖 @napi-rs/canvas。
# NODE_PATH 指向含 @napi-rs/canvas 的 node_modules。
#
# 为什么缺依赖默认算失败：旧版跳过第 6~8 步后仍然打印「全部验证通过 ✔」，
# 看起来像跑满了，实际少验了三分之一的断言（复核报告点名）。
# 验证脚本"静默降级"就是假验证的开始，所以默认必须吵出来。

cd "$(dirname "$0")/.." || exit 1

: "${NODE_PATH:=./node_modules}"
export NODE_PATH

NODE="${NODE:-$(command -v node)}"
if [ -z "$NODE" ]; then echo "找不到 node，请先安装 Node.js"; exit 1; fi

FAILED=0
SKIPPED=0
SKIPPED_NAMES=""
TOTAL=13
run() {
  name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  $name"
  echo "════════════════════════════════════════════════════════"
  if "$@"; then :; else FAILED=$((FAILED + 1)); echo "  ↑ 本项未通过"; fi
}
skip() {
  SKIPPED=$((SKIPPED + 1))
  SKIPPED_NAMES="$SKIPPED_NAMES
     · $1"
}

  run "1/13 静态检查（WXML 配对 / 事件处理器 / 语法）" "$NODE" verification/static_check.js
  run "2/13 存储层（含回滚失败注入）"                "$NODE" verification/storage_offline_test.js
  run "3/13 渲染层（格内色号 / 图例）"               "$NODE" verification/render_offline_test.js
  run "4/13 多品牌色号（数据 / 加载器 / 转换 / 性能）" "$NODE" verification/brands_offline_test.js
  run "5/13 模块识别算法（editor.js 实际移植代码）"    "$NODE" verification/editor_extract_test.js

# 以下 6 步依赖 @napi-rs/canvas
if [ -d "$NODE_PATH/@napi-rs/canvas" ]; then
  run "6/13 审查 P1 回归（真实入口全链路）" "$NODE" verification/audit_p1_regression_test.js
  run "7/13 组 B 回归（透明语义 / 权威网格 / 网格持久化）" "$NODE" verification/groupB_grid_test.js
  run "8/13 组 C 回归（打印图不裁切 / 格内色号 / 分页与绝对坐标）" "$NODE" verification/groupC_print_test.js
  run "9/13 组 D 回归（复核 R1 填充死循环 / R2 撤销删隐藏颜色）" "$NODE" verification/groupD_editor_test.js
  run "10/13 组 E 回归（复核 R3 未知品牌 / R4 A4 施工图 / R5 抠图导出 / R6 回滚事务 / R7 色号同源）" "$NODE" verification/groupE_recheck2_test.js
  run "11/13 组 F 回归（三轮复核 S1 换品牌完整性 / S2 内容校验 / S3 救援区 / S4 真实色号 8pt / S5 图例不裁切）" "$NODE" verification/groupF_recheck3_test.js
  run "12/13 组 G 回归（界面审计第一批 P0：全局 loading / 锁文案与震动 / 上传取消与互斥）" "$NODE" verification/groupG_p0quick_test.js
  run "13/13 组 H 回归（转换质量：自动裁剪不吃部件不吃蓝底 / 照片五官不合并）" "$NODE" verification/groupH_convert_quality_test.js
else
  echo ""
  echo "  [跳过] 找不到 $NODE_PATH/@napi-rs/canvas"
  echo "         安装：npm install @napi-rs/canvas   然后设置 NODE_PATH 指向该 node_modules"
  skip "6/13 审查 P1 回归"
  skip "7/13 组 B 回归"
  skip "8/13 组 C 回归"
  skip "9/13 组 D 回归"
  skip "10/13 组 E 回归"
  skip "11/13 组 F 回归"
  skip "12/13 组 G 回归"
  skip "13/13 组 H 回归"
fi

echo ""
echo "────────────────────────────────────────────────────────"
if [ "$FAILED" -gt 0 ]; then
  echo "有 $FAILED 项未通过，请先修复（已跳过 $SKIPPED 项）"
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  echo "已通过 $((TOTAL - SKIPPED))/$TOTAL 项，$SKIPPED 项**被跳过、未验证**：$SKIPPED_NAMES"
  if [ "${ALLOW_SKIP:-0}" = "1" ]; then
    echo "（ALLOW_SKIP=1：本次不判失败，但这不是完整验证）"
    exit 0
  fi
  echo "→ 判定为失败：验证不完整不能算通过。确定要忽略就加 ALLOW_SKIP=1 重跑。"
  exit 1
fi
echo "全部 $TOTAL 项验证通过 ✔"
