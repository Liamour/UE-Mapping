═══════════════════════════════════════════════════════════════════════
 AICartographer — 必读：5 分钟跑起来
═══════════════════════════════════════════════════════════════════════

是什么：嵌入到 Unreal Engine 5 编辑器里的 AI 蓝图地图仪。
        给整个 UE 项目的蓝图建一份"叙事地图"，画系统形状，写谁调用谁。

需要什么：
  ▢ Windows 10 / 11
  ▢ Unreal Engine 5.6+（含 5.7）
  ▢ Visual Studio 2022（带 C++ 工作负载）— UE 第一次开会用它编插件
  ▢ Python 3.11 或更高 — 装时务必勾上 "Add Python to PATH"
        下载：https://www.python.org/downloads/
  ▢ LLM API key（Volcengine endpoint id 或 Anthropic Claude key）

  注：本包**已自带 Redis**，无需另装 Memurai 或 Redis Server。

═══════════════════════════════════════════════════════════════════════
 第一次使用（约 5 步）
═══════════════════════════════════════════════════════════════════════

  ① 双击 START.bat
       第一次运行会自动创建 Python 虚拟环境并装依赖（约 1-3 分钟，
       看网速）。此后每次启动是几秒钟。
       看到 "AICartographer is running" 就成功了。
       ▶ 这个窗口不要关，关了后端就停了。要停服务有两种方式：
           • 在窗口里按 Ctrl+C（推荐）
           • 直接关窗口，然后双击 STOP.bat 清理残留

  ② 双击 INSTALL-PLUGIN.bat
       脚本会列出 Documents\Unreal Projects 下检测到的项目，
       选一个或手动粘贴 .uproject 路径。它会：
         - 把插件拷到 <你项目>\Plugins\AICartographer\
         - 自动改 .uproject 把插件标记为启用
         - 打开 Plugins 文件夹让你确认
       一个项目只需跑一次。多个项目就跑多次。

  ③ 打开你的 .uproject
       第一次打开会弹"Missing Modules"，点 Yes 让 UE 编译插件。
       编译需要 1-2 分钟，需要 Visual Studio 装好 C++ 工作负载。

  ④ UE 编辑器里：Window → Developer Tools → Misc
       找 "AICartographer Web UI"，点开。
       面板会以 WebView 形式嵌进编辑器。

  ⑤ 配置（在 AICartographer 面板内）
       右上角齿轮图标 → Settings：
         • Project root：填你项目根目录（即 .uproject 所在文件夹）
         • Language：英文 / 简体中文
         • LLM Provider：选 Volcengine 或 Claude
             - Volcengine：endpoint id（ep-... 开头）+ API key
             - Claude：API key + 模型 + effort 档位
         • 点 Test connection 验证（绿色就是通了）

         然后回到主界面：
         • Settings → Run framework scan（秒级，不用 LLM，写出骨架）
         • 顶栏 → Run project scan（30 秒到几分钟，吃 LLM 配额）
         • 完成后 Lv0 → Lv1 → Lv2 → Lv3 一路点

═══════════════════════════════════════════════════════════════════════
 常见问题
═══════════════════════════════════════════════════════════════════════

Q: START.bat 一闪就关 / 报 "Python not found"
A: Python 没装或没勾 "Add to PATH"。重装 python.org 的 3.12 安装包，
   安装第一步勾上 "Add Python to PATH"，重开命令行验证：
     python --version
   能看到 "Python 3.12.x" 就行。再双击 START.bat。

Q: START.bat 报 "venv creation failed"
A: 通常是把这个目录解压到了 Program Files 之类需要管理员权限的位置。
   挪到 D:\AICartographer\ 之类的普通目录再试。

Q: START.bat 报 "Port 8000 already in use"
A: 上次没关干净。先双击 STOP.bat 清理，再双击 START.bat。

Q: UE 打开 .uproject 报 "Missing Modules"，问要不要重编
A: 选 Yes。这是预期行为 — 插件是源码形式分发，UE 第一次会用 VS 编一遍。
   如果按 Yes 后报 VS 找不到 / 编译失败，确认 VS 2022 装好且勾了
   "使用 C++ 的桌面开发"工作负载。

Q: UE 里没看到 AICartographer 标签
A: 三步排查：
     1) Edit → Plugins → 搜 AICartographer，确认勾选 + 已加载（绿色）
     2) 重启 UE
     3) Window → Developer Tools → Misc → AICartographer Web UI

Q: 面板里 backend 一直显示 offline
A: START.bat 没在跑，或 Python 后端崩了。回到 START.bat 那个窗口看错误。

Q: LLM Test connection 报 401 / 403
A: API key 错了或 endpoint id 错了。Volcengine 注意 endpoint id 和 key
   是两个不同的字符串，都要填。

Q: 切了简体中文，但已生成的 .md 还是英文
A: 已存在的 .md 不会自动重写。两种办法：
     • 删 <你项目>\.aicartographer\vault\ 整个目录，重扫
     • 或改一下蓝图触发 AST 变化，让那个节点重扫

Q: 想升级到新版本
A: 关 UE，关 START.bat 那个窗口，把新版 zip 解到同位置覆盖即可。
   runtime\python-venv 里的依赖会被 START.bat 自动同步。

═══════════════════════════════════════════════════════════════════════
 目录里有什么
═══════════════════════════════════════════════════════════════════════

  START.bat            ← 启动后端（双击）
  STOP.bat             ← 停止后端 / 清理残留
  INSTALL-PLUGIN.bat   ← 把插件拷进一个 UE 项目
  README-FIRST.txt     ← 你正在看的这份

  backend\             ← Python FastAPI 后端源码
  plugin\AICartographer\  ← UE 插件（C++ 源码 + 已编译 React WebUI）
  runtime\redis\       ← 便携 Redis 二进制
  runtime\python-venv\ ← 自动创建的 Python 虚拟环境（首次启动后才有）
  tools\               ← 启动脚本本体（launcher.py 等）

═══════════════════════════════════════════════════════════════════════
 报 bug / 反馈
═══════════════════════════════════════════════════════════════════════

  https://github.com/Liamour/UE-Mapping/issues

  贴 bug 时尽量带：
    • UE 版本 + Windows 版本
    • START.bat 那个窗口的报错截图
    • 触发步骤（点了什么按钮）

═══════════════════════════════════════════════════════════════════════
