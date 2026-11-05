# 在 DeepSeek Harness 桌面版安装本插件

> 2026-11-05 实测通过。适用于 DSH 桌面版 0.2.2-rc.1。

**不需要装 CLI，不需要 pnpm。** 桌面版自带插件市场，本插件走手动挂载。

---

## 前置条件

- DSH 桌面版已安装（本机路径：`D:\Program Files (x86)\DeepSeek Harness`）
- 桌面版**完全退出**（托盘图标也要退出），改配置前必须先关掉

---

## 安装步骤

### 1. 复制插件文件

```bash
# 插件源目录
SRC="D:/AAAxiuxing/AI/dsh回复内容美化插件"

# 目标：桌面版 profile 的 node_modules
DST="$HOME/.dsh/profiles/desktop/node_modules/dsh-rich-response"

mkdir -p "$DST"
cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/LICENSE" \
   "$SRC/README.md" "$SRC/PLUGIN-README.md" "$DST/"
cp -r "$SRC/lib" "$SRC/src" "$SRC/scripts" "$SRC/skills" "$SRC/protocol" "$DST/"
```

> 只复制运行时必需的文件。`tests/`、`docs/` 不进 node_modules。

### 2. 注册到 profile

编辑 `~/.dsh/profiles/desktop/package.json`，两处：

```jsonc
{
  "dependencies": {
    // …
    "dsh-rich-response": "0.1.0"        // ← 加这一行
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …
        "dsh-rich-response"               // ← 加这一行
      ]
    }
  }
}
```

### 3. 挂载插件

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在末尾追加：

```yaml
- id: ui-rich-response
  name: dsh-rich-response
```

> **注意格式**：profile 的这个文件是**扁平列表**（`- id:` / `name:`），
> 和插件自己那个 `insert:` 嵌套格式的 `cordis.patch.yml` 是两套东西，别搞混。

### 4. 重启桌面版

bundle 层只在进程启动时组装，**必须完全重启 DSH**（关窗口不够，要退托盘）。

---

## 验证

### 静态验证（不用启动 DSH）

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-rich-response
node -e "
const fs=require('fs');
const c=fs.readFileSync('lib/client.js','utf8');
console.log('slot key:', c.includes('assistant-step'));
console.log('priority:', c.includes('priority: -10'));
console.log('CSS:', c.includes('__RR_CSS__'));
"
```

### 运行时验证

1. 打开 DSH → **Settings → Plugins → Plugin list**
2. 找到 `dsh-rich-response`，确认已启用
3. 新建会话，让模型输出结构化内容：

```
:::summary{title="结论"}
丢失的是**可定位坐标**，不是数据本身。
:::

:::points{cols="3"}
- **数据在** — ref 会读写
- **入口没了** — 页面方式取不回
- **uuid 不可转** — 无法塞进另一条对循环
:::
```

4. 预期：回复渲染成带底色和左边框的卡片

### 调试入口

- DevTools Network：应看到 `/plugins/dsh-rich-response/client.js` 请求
- 若插件没生效：看 Console 有无 `[dsh-rich-response]` 开头的日志
  - "宿主缺少 xxx" → 宿主版本过老，插件主动放弃接管（不白屏）
  - "注册失败" → slot 注册出错，宿主渲染不受影响

---

## 更新插件

改完源码后：

```bash
# 1. 重新构建
cd "D:/AAAxiuxing/AI/dsh回复内容美化插件"
npm run test:all        # 66 项测试，顺便重建 lib/

# 2. 同步到桌面版
DST="$HOME/.dsh/profiles/desktop/node_modules/dsh-rich-response"
cp package.json "$DST/"
cp lib/*.js "$DST/lib/"
cp src/*.js src/*.css "$DST/src/"

# 3. 重启 DSH
```

改 `client.js` 只需硬刷新（Ctrl+Shift+R）；但改了 `package.json` 或
`cordis.patch.yml` 必须重启进程。

---

## 卸载

```bash
# 1. 从 profile/package.json 移除 dependencies 与 bundles 两项
# 2. 从 profile/cordis.patch.yml 删除 ui-rich-response 条目
# 3. 删目录
rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-rich-response
# 4. 重启 DSH
```

---

## 备份位置

改动前的备份在：

```
~/.dsh/profiles/desktop/_backup-before-rich-response_20261105-132943/
├── cordis.patch.yml
├── package.json
└── pnpm-workspace.yaml
```

出问题直接覆盖回去即可。
