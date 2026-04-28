# RenderFusion 浏览器端改动说明

本文档整理 **arena-web-core** 中为配合「智能决策 / 纯远程 / 纯本地」三模式而做的浏览器端修改，对应实现位于 hybrid 渲染客户端与 `remote-render` 组件。

---

## 涉及文件

| 文件 | 说明 |
|------|------|
| `src/systems/renderfusion/render-client.js` | 订阅 `render-decisions` 数据通道、解析消息、全局模式与逐物体决策、场景增量监听 |
| `src/components/renderfusion/remote-render.js` | 判空与 `model-loaded` 单次监听，避免异常与重复绑定 |

---

## 背景与目标

- Unity 通过 WebRTC DataChannel（label：`render-decisions`）下发每物体的渲染决策及（需 Unity 配合的）全局模式广播。
- 浏览器原先未消费该通道，导致纯本地/纯远程在视觉上与预期不符。
- 浏览器侧通过 **`remote-render.enabled`** 控制本地几何是否显示（组件内 `visible = !enabled`），并配合 **`compositor`** 的启用/禁用，使三种模式行为与方案一致。

---

## `render-client.js` 改动摘要

### 1. 常量与白名单

- `REMOTE_RENDER_SKIP_IDS`：`env`、`my-camera`、`cameraRig`、`floor`。
- `shouldSkipRemoteRenderEntityId(id)`：上述集合 + 前缀 `jitsi-` + 空 id 均跳过，不对这些节点写 `remote-render`。

### 2. 组件状态（`init`）

初始化字段：

- `pendingDecisions`：物体 id 尚未出现在 DOM 时缓存的「是否远端渲染」决策。
- `currentGlobalMode`：当前全局模式字符串（`pure_local` / `pure_remote` / `smart` 等）。
- `renderDecisionsChannel`：当前 PC 上的 `render-decisions` 通道引用。
- `_sceneMutationObserver`：`a-scene` 子树监听实例。

### 3. `ready()` 末尾

- 调用 `_attachSceneMutationObserver()`，在场景加载完成后对已有 `a-entity[id]` 做一次 flush，并持续监听新增节点。

### 4. `gotOffer()`：订阅 Unity 创建的 DataChannel

- 每次新建 `RTCPeerConnection` 时将 `renderDecisionsChannel` 置空。
- 设置 `pc.ondatachannel`：仅当 `evt.channel.label === 'render-decisions'` 时绑定 `onmessage` → `onRenderDecisionMessage`。

> 不在浏览器侧 `createDataChannel('render-decisions')`，与 Unity 作为 offerer 创建通道的约定一致。

### 5. 消息处理 `onRenderDecisionMessage(ev)`

解析 JSON 后按 `type` 分发：

| `type` | 行为 |
|--------|------|
| `render_decision` | `applyPerObjectDecision(objectId, renderMode === 0)`（约定：**0 = Remote，1 = Local**） |
| `render_mode` | `applyGlobalRenderMode(mode)`，`mode` 为 `pure_local` / `pure_remote` / `smart`（其它值按 smart 分支处理） |

解析失败则静默忽略。

### 6. 合成器 `ensureCompositorPassEnabled()`

- `compositor.disable()` 会从 `EffectComposer` 链中移除 pass，仅设 `pass.enabled = true` 不足以恢复。
- 若 `compositor.pass` 存在且不在 `effects.composer.passes` 中，则 `effects.insertPass(compositor.pass, 0)`，并置 `pass.enabled = true`。

### 7. 全局模式 `applyGlobalRenderMode(mode)`

| 模式 | 行为概要 |
|------|----------|
| `pure_local` | 全场景（除白名单）`remote-render.enabled = false`；`compositor.disable()`；`#env` 可见；隐藏 `remoteVideo`。 |
| `pure_remote` | 全场景 `remote-render.enabled = true`；`ensureCompositorPassEnabled()`；`#env` 不可见。 |
| `smart` / 其它 | 恢复 compositor；`#env` 不可见；先全量 `remote-render.enabled = false`，再按 `pendingDecisions` 快照补应用，后续依赖逐条 `render_decision`。 |

进入 smart 时先全量本地再补 pending，用于从 `pure_remote` 切回时清掉「全远端」状态，避免在 Unity 未立即重发决策前画面错误。

### 8. 逐物体决策 `applyPerObjectDecision(objectId, isRemote)`

- 白名单 `objectId` 直接 return。
- 若 DOM 中尚无对应 `a-entity`，写入 `pendingDecisions[objectId] = isRemote`。
- 否则 `entity.setAttribute('remote-render', 'enabled', isRemote)`，并删除对应 pending。

`findArenaEntityByObjectId`：`document.getElementById(objectId)` 且节点匹配 `a-entity`。

### 9. 批量设置 `setAllArenaEntitiesRemoteRender(enabled)`

- 在 `sceneEl` 上 `querySelectorAll('a-entity[id]')`，跳过白名单后统一设置 `remote-render.enabled`。

### 10. 场景增量 `_attachSceneMutationObserver` / `_onArenaEntityAttached`

- `MutationObserver` 监听 `sceneEl` 的 `childList` + `subtree`。
- 新增 `a-entity[id]`（含子树内新增）时：
  - 若 `pendingDecisions` 中有该 id，优先应用并清除 pending；
  - 否则若 `currentGlobalMode === 'pure_local'` → `enabled = false`；
  - 若 `pure_remote` → `enabled = true`；
  - `smart` 且无 pending：不批量改，保持默认或由后续 `render_decision` 更新。

### 11. 断线 `handleCloudDisconnect()`

在原有逻辑上补充：

- `env` 判空后再设 `visible`。
- `setAllArenaEntitiesRemoteRender(false)`，恢复本地几何默认可见策略。
- 清空 `pendingDecisions`、`currentGlobalMode`、`renderDecisionsChannel`。
- `remoteVideo` 判空后再隐藏。

---

## `remote-render.js` 改动摘要

- **`init`**：无 `el` 则 return；`gltf-model` 的 `model-loaded` 使用 `{ once: true }`，避免重复触发统计逻辑。
- **`getObjectStats`**：无 `el` 或无 `sceneEl` 则 return。
- **`update`**：无 `el` 则 return；仍为 `visible = !enabled`（`enabled === false` 时本地可见）。

---

## 与 Unity 的协议约定（浏览器侧假设）

1. **DataChannel**：由 Unity 创建，label 必须为 `render-decisions`。
2. **`render_decision`**：`objectId`（与页面 `a-entity` 的 `id` 一致）、`renderMode`（0 Remote / 1 Local）。
3. **`render_mode`**：`mode` 为 `pure_local` | `pure_remote` | `smart`（需 Unity 发送 `type: "render_mode"` 的 JSON）**。

若 Unity 尚未下发 `render_mode`，会话建立后仍会执行既有 `gotAnswer` 逻辑（例如隐藏 `env`），直至收到首条 `render_mode` 后由 `applyGlobalRenderMode` 统一校正。

---

## 扩展白名单

若场景中存在不宜被 `remote-render` 批量切换的实体 id，在 `render-client.js` 的 `REMOTE_RENDER_SKIP_IDS` 或 `shouldSkipRemoteRenderEntityId` 中按需增补（例如特定 UI、辅助物体）。

---

## 文档与代码同步

- 代码路径：`arena-web-core/src/systems/renderfusion/render-client.js`、`arena-web-core/src/components/renderfusion/remote-render.js`
- 若后续修改上述实现，请同步更新本说明。
