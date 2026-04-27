# AICartographer 安装指南

> 这是给同事看的简版安装文档。
> 想了解项目本身：先看 [README.md](README.md) 或 [README.en.md](README.en.md)。
> 想看完整工程交接：看 [HANDOFF.md](HANDOFF.md)（开发者向）。

---

## 你需要的环境

| 软件 | 版本 | 用途 | 必装吗 |
|---|---|---|---|
| **Unreal Engine** | 5.7 | 跑插件 | ✓ |
| **Python** | 3.11+ | 后端 LLM 流水线 | ✓ |
| **Memurai**（Windows Redis） | 任意 | 任务队列 | ✓ |
| **LLM API key** | — | 火山引擎 endpoint id 或 Anthropic key | ✓（用 LLM 功能时） |

> Memurai 是 Windows 上 Redis 的活跃维护版（免费 Developer 版即可）。Linux/Mac 可以直接用官方 Redis。

---

## 安装步骤（约 15 分钟）

### 1. 解压发行包

把 `AICartographer-vX.Y.Z.zip` 解压到任意位置，比如 `D:\AICartographer\`。结构应该是这样：

```
AICartographer/
├── Plugins/AICartographer/      # UE 插件（已 build 好）
├── backend/                     # Python 后端源码
├── dist/
│   ├── setup-backend.ps1        # 一键装依赖
│   └── start-backend.ps1        # 一键启动
├── INSTALL.md                   # 本文件
└── README.md
```

### 2. 把插件拷到你的 UE 项目

把 **`Plugins/AICartographer/`** 整个目录拷到你 UE 项目根目录的 `Plugins/` 下：

```
你的UE项目/
├── YourGame.uproject
└── Plugins/
    └── AICartographer/    ← 拷到这里
```

如果项目根目录还没有 `Plugins/`，自己建一个。

### 3. 装 Python 3.11+

如果还没装：去 [python.org/downloads](https://www.python.org/downloads/) 下 Python 3.12 或更新。

> ⚠️ **安装时勾上 "Add Python to PATH"**，不然下一步 PowerShell 找不到。

装完开新 PowerShell 验证：
```powershell
python --version
# 应该输出 Python 3.12.x 或更高
```

### 4. 装 Memurai（Windows Redis）

去 [memurai.com/get-memurai](https://www.memurai.com/get-memurai) 下载 Developer 版，一路 next 装完。Memurai 安装时会注册成 Windows 服务并自动启动。

### 5. 跑安装脚本

打开 PowerShell，cd 到解压目录，跑：

```powershell
.\dist\setup-backend.ps1
```

脚本会做 4 件事：
1. 检查 Python 版本
2. 在 `backend\.venv` 建虚拟环境
3. pip 装 backend/requirements.txt 的依赖
4. 检查 Memurai 是否能找到

> **如果 PowerShell 报 "无法加载文件...因为禁止运行脚本"**：
> 先开管理员 PowerShell 跑一次：
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
> 再回到普通 PowerShell 重跑 setup 脚本。

### 6. 启动后端

```powershell
.\dist\start-backend.ps1
```

应该能看到 Redis PID + uvicorn 在 8000 端口起来的日志。**这个窗口先别关**，关了后端就停了。

后台跑也行，建议第一次跑保持窗口看日志。

### 7. 在 UE 编辑器里启用插件

第一次需要在 UE 里启用：
1. 打开你的 UE 项目
2. UE 顶部菜单 **Edit → Plugins** → 搜 "AICartographer"
3. 勾上启用 → 重启 UE

### 8. 配置 + 第一次扫描

UE 重启后：

1. **打开 AICartographer 面板**
   - UE 菜单栏 → AICartographer 标签（或 Window → AICartographer）

2. **设置 Project root**
   - 右上角齿轮 → Settings
   - Project root 填你 UE 项目的根目录路径（比如 `D:\MyGame`）

3. **配 LLM**
   - Settings → LLM provider 选你用的（Volcengine / Claude）
   - 填 API key（火山引擎的 endpoint id 是 `ep-...` 开头）
   - 点 **Test connection**，绿了就行

4. **选语言**（可选）
   - Settings → Language → English / 简体中文
   - UI 和 LLM 输出都跟着切换

5. **第一次扫描**
   - Settings → **Run framework scan**（秒级，不用 LLM，写出骨架 .md）
   - 顶栏 → **Run project scan**（30 秒到几分钟，根据 BP 数量；这一步会花 LLM 配额）
   - 完成后进 Lv0 总览看效果，然后点系统 → Lv1，点蓝图 → Lv2，点函数 → Lv3

---

## 常见问题

### `setup-backend.ps1` 报错 "Python 3.11+ not found"
开新 PowerShell 跑 `python --version`。如果命令不存在，Python 没装或没勾 PATH。重装 Python 时勾上 "Add Python to PATH"。

### `setup-backend.ps1` 报 "venv creation failed"
通常是磁盘权限。换一个目录解压（避开 Program Files 之类的需要管理员权限的位置）。

### `start-backend.ps1` 报 "Redis not found"
Memurai 没装或没起来。
- 装了 Memurai：开 Services（Win+R → `services.msc`），找 Memurai，确认状态是 Running
- 没装：去 [memurai.com](https://www.memurai.com/get-memurai)

### `start-backend.ps1` 报 "Redis exited immediately (port 6379 already in use?)"
6379 端口被占了。要么是 Memurai 服务已经在跑（这种情况脚本不需要再起一份，可以直接 cd backend 然后 `.\.venv\Scripts\python.exe -m uvicorn main:app --port 8000`），要么有别的 Redis 在跑。

### UE 里没看到 AICartographer 面板
- 确认 `Plugins/AICartographer/` 拷到 UE 项目根的 `Plugins/` 下了
- UE → Edit → Plugins 里搜 AICartographer，确认勾选启用
- 重启 UE

### LLM Test connection 报 401 / 403
API key 错了。火山引擎注意：endpoint id（`ep-...`）和 API key 是两个不同的东西，两个都要填对。

### Settings 里 backend 一直显示 offline
后端 uvicorn 没起来。回 PowerShell 看 `start-backend.ps1` 的窗口有没有报错。

### 扫描完 markdown 是英文的，但我设置了中文
已存在的 `.md` 不会自动重新翻译。两种办法：
- 删掉 `<你UE项目>/.aicartographer/vault/` 目录然后重扫
- 或者改个蓝图的内容触发 AST hash 变化，再扫就会用新语言重写

---

## 升级到新版

发布新版时：

1. 关掉 UE 编辑器和后端 PowerShell 窗口
2. 解压新版 zip 覆盖旧目录（Memurai 不动，Python 不动）
3. 把新的 `Plugins/AICartographer/` 拷过去覆盖（或先删旧的再拷新的）
4. 重跑 `.\dist\setup-backend.ps1`（更新 Python 依赖）
5. `.\dist\start-backend.ps1` 再次启动后端
6. 打开 UE

如果新版改了 frontmatter schema，可能需要删 vault 重扫一次。release notes 会写。

---

## 报 bug / 提需求

[github.com/Liamour/UE-Mapping/issues](https://github.com/Liamour/UE-Mapping/issues)

提 bug 时尽量带：
- UE 版本 + Windows 版本
- 后端 PowerShell 窗口的报错截图
- 触发步骤
