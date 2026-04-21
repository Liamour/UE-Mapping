#!/bin/bash

# ==========================================
# 自动化同步协议 (Global Sync Protocol v1.0)
# ==========================================

# 1. 定义时间戳（精确到秒，确保版本唯一性）
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
# 2. 定义快照分支名称
BACKUP_BRANCH="archive/v-$TIMESTAMP"

echo "------------------------------------------"
echo "🚀 开始执行全球标准同步流程..."

# 3. 自动化 Git 提交逻辑
# 检查是否有未暂存的更改
git add .

# 检查是否有任何提交内容
if ! git diff-index --quiet HEAD --; then
    echo "📦 发现新更改，正在生成原子化提交..."
    git commit -m "sync: 自动保存于 $TIMESTAMP"
else
    echo "✨ 当前工作区干净，准备同步已有历史..."
fi

# 4. 执行双路径推送
# 路径 A: 推送到日期快照分支（保存历史）
echo "📁 正在创建备份快照: $BACKUP_BRANCH"
git push origin HEAD:refs/heads/$BACKUP_BRANCH

# 路径 B: 强制同步到主 main 分支（确保主线最新）
echo "⬆️ 正在强制更新远程 main 分支..."
git push origin HEAD:main -f

echo "------------------------------------------"
echo "✅ 同步成功！"
echo "📍 主线: main (已更新)"
echo "📍 快照: $BACKUP_BRANCH (已保存)"
echo "------------------------------------------"