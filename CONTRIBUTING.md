# 参与贡献

欢迎任何人参与这个项目的创作和修改。你不需要先打招呼，直接按下面的流程动手即可。

## 三种参与方式

1. **报问题或提想法**：在仓库的 Issues 里新建一条。请写清楚你用的是哪个页面、做了什么操作、看到了什么、你期望看到什么。
2. **改代码或改文档**：Fork 本仓库，从 `main` 建一个新分支，改完后向本仓库的 `main` 发起 Pull Request。
3. **补充色号数据**：品牌色号表放在 `tools/beadcolors/` 下，生成脚本是 `tools/gen_brands.py`。改动色号数据时，请一并说明数据来源。

Pull Request 的描述里请写清楚三件事：你改了什么、为什么要改、你怎么验证的。一个 Pull Request 尽量只解决一件事，这样别人更容易看懂，也更容易合并。

## 把项目跑起来

1. 安装「微信开发者工具」，选择「导入项目」，目录指向本仓库根目录。
2. 打开根目录的 `project.config.json`，把 `appid` 的占位值 `YOUR_APPID_HERE` 换成你自己的小程序 AppID；也可以在开发者工具里选择「测试号」。
3. 基础库选择 3.0.0 或更高版本，编译后即可在模拟器里使用。

云开发相关的功能放在 `cloudfunctions/imgSecCheck/` 与 `cloudfunctions/syncHistory/`，两者都依赖 `wx-server-sdk`。使用者需要在微信公众平台开通云开发并部署这两个云函数；未开通时程序会自动退回本地存储，所以不部署也能体验主要功能。

## 改完请跑验证

仓库的 `verification/run_all.sh` 会依次运行 13 组离线检查。执行方式是：

```
sh verification/run_all.sh
```

运行前需要 Node.js。第 6–13 组依赖 `@napi-rs/canvas`，使用者需要安装该模块，并把 `NODE_PATH` 指向包含它的 `node_modules` 目录。缺少依赖时脚本会列出跳过项并判定失败，不会静默通过；如果只是本机自测，可以加 `ALLOW_SKIP=1`，但那不算完整验证。

改动 JavaScript 文件时，建议先用 `node --check 文件路径` 做一次语法检查。

## 提交前自查

- 不要把真实 AppID、密钥、云端凭证写进文件。
- 不要把私人照片、生成图纸、本地调试截图提交进仓库。`.gitignore` 已经排除了 `inputs/`、`outputs/`、`.workbuddy/`、`project.private.config.json` 等路径，请不要用 `git add -f` 强行加入。
- 改动 `pages/` 下的界面时，请顺手确认「制作 → 编辑 → 预览 → 历史」这条主流程还能走通。
- 改动 `utils/` 下的算法时，请在 Pull Request 里说明你跑了哪几组验证。

## 关于授权

本仓库采用 MIT 许可证，完整文本见根目录的 `LICENSE`。向本仓库提交 Pull Request 时，请在描述里确认你同意自己的改动按仓库采用的许可证一同发布。使用者保留版权与许可证声明后，可以自由使用、修改和分发这些代码。
