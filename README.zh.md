# tokstat

Hermes Desktop 插件：聚焦会话的实时 token 用量，钉在状态栏右侧。

Language: [English](README.md) · **中文（本页）**

```
Total 1.1M · Turn 32K · Last 31K · Context 97% · Cache 56%
```

- **总量** — 该会话累计 token（精简单位显示）。
- **本轮** — *正在生成的这一轮* 的 token，实时计数。
- **上轮** — 上一轮回答的 token（本轮结束后显示）。
- **上下文** — 上下文窗口占用百分比。
- **缓存** — 提示缓存命中率。

鼠标悬停显示精确数字（输入 / 输出 / 总量，加上模型名）。

标签与 tooltip 提供中英双语，界面文字跟随 Hermes Desktop 的语言设置（Settings → Language）；英文为默认。

## 工作原理

无轮询、无 RPC。插件监听三个网关事件：

| 事件 | 角色 |
|---|---|
| `session.usage` | 生成中每秒一次的 ticker，携带会话累计用量 |
| `message.start` | 轮次边界 —— 把累计总量快照成「本轮」基线 |
| `message.complete` | 轮次边界 —— 把 `本轮 − 基线` 定为「上轮」 |

两种 payload 形状都兼容：`payload.usage`（网关 ticker）与顶层 `total_tokens` / `context_tokens`（本地查看器）。如果 `message.complete` 不带 usage，就用最后一帧 ticker 快照作为上轮值。

插件热重载（或全新会话）时基线未知，*第一帧* ticker 快照自己成为基线 —— 这样「本轮」从那点开始计数，而不是把「总量」镜像出来。

## 安装

**从目录安装**（上架后）：

```bash
hermes plugins install tokstat
```

**从 Git 安装**（过渡期）：Settings → Plugins → Install from Git，或：

```bash
mkdir -p ~/.hermes/desktop-plugins/tokstat
cp desktop/plugin.js ~/.hermes/desktop-plugins/tokstat/plugin.js
```

然后 **⌘K → Reload desktop plugins**（或直接等——目录是被监听的）。

## 披露

- 仅桌面端；单文件插件，无网关侧代码，无网络调用，不声明 `requires_env`。
- 只读取网关已经报出来的 usage 数据，不重新测量。
- 本轮数字是累计差分快照，**不是**服务商计量。
- 若某构建 flavor 缺 `session.usage` ticker，芯片显示占位符「聚焦会话还没有上报用量」，不会展示陈旧数据。

## i18n 合约（踩坑 lessons learned）

`ctx.i18n.register` / `usePluginI18n` 遵循宿主的 catalog 规则，其中两条静默的坑：

1. **Bundle 必须是嵌套树。** key 通过 `.` 走树来 resolve，所以平铺的 `'label.total': '总量'` entry 永远匹配不到 —— lookup 会回 raw key，所有 locale 都是。كتب `label: { total: '总量' }`，调用时还用 dotted path `t('label.total')`。
2. **插值消息必须是 functions。** 纯字符串会被原样返回，`{0}` / `{1}` *不会*被代入（这种便利只存在于通过 `registerAppLocale` 注册的 app-level language pack，plugin bundle 没有）。要用 `total: (n, i, o) => \`总量：累计 ${n}…\``。

组件走 `usePluginI18n('tokstat')` 而非 `ctx.i18n.t`：后者采样 locale 但永远不重渲染，所以 live language switch 时芯片会 stranded 在旧语言里，直到下一个 usage 事件。

## 测试

```bash
node --test tests/plugin.test.mjs
```

Tests 导入真实的 `desktop/plugin.js`，用 stubbed SDK（官方单文件桌面插件测试模式）；没 build step。`usePluginI18n` stub 模拟 host（dotted-path walk、`en` fallback、最后 key），不再回 friendly strings——这就是把两条 i18n 规则 keep honest 的测试。

---

