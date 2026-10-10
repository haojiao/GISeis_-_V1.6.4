# GISeis 测量质检助手

当前版本：**1.6.5**。补充实际测量质检页面入口，修复旧脚本安装后在新入口不显示面板的问题。
为让已有安装覆盖更新，脚本安装名称和文件名仍沿用 V1.6.4；油猴管理面板的版本列显示 1.6.5。

## 安装与更新

1. 在准备使用的 Chrome 或 Edge 中安装 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/index.php?locale=zh)。
2. 打开浏览器扩展管理页面（Chrome：`chrome://extensions`；Edge：`edge://extensions`），进入 Tampermonkey 详情，开启“允许用户脚本”。没有该选项时，开启扩展页面的“开发者模式”。[官方说明](https://www.tampermonkey.net/faq.php?locale=zh&q=Q209)
3. 在 Tampermonkey 的网站访问设置中允许访问 `https://www.giseis.com`。
4. 打开 [脚本安装／更新链接](https://raw.githubusercontent.com/haojiao/GISeis_-_V1.6.4/main/tampermonkey_scripts/GISeis%20%E6%B5%8B%E9%87%8F%E8%B4%A8%E6%A3%80%E5%8A%A9%E6%89%8B%20V1.6.4.user.js)，确认安装或更新。
5. 在油猴管理面板确认脚本已启用，版本列显示 **1.6.5**。已有用户更新后应保留一个同名脚本。

也可以下载 [ZIP 安装包](https://raw.githubusercontent.com/haojiao/GISeis_-_V1.6.4/main/tampermonkey_scripts.zip)，在“油猴管理面板 → 实用工具 → ZIP 导入”中选择文件，确认导入／覆盖已有安装。[官方导入说明](https://www.tampermonkey.net/faq.php?locale=zh&q=Q106)

## 使用

1. 登录 GISeis，打开 [测量质检页面](https://www.giseis.com/html/M_CHK/Q_Check_Survey.html)。旧入口 `/Fun/OpenCheck_Chk_Sur` 也继续支持。
2. 刷新页面，等待约 2 秒出现助手面板，默认状态为“等待开始”。
3. 输入本轮质检数量，点击“开始审核”。需要中断时点击“停止审核”。

启动后会实际提交审核结果：线号和点号分别与归算编号一致、且有照片或视频时自动通过；编号不一致或两种媒体都没有时，填写不通过原因并自动点击“不通过”。通过和不通过均计入审核数量，达到数量后停止。每两条至少间隔 6 秒。字段缺失、媒体加载中或提交未确认时会等待或停止。

## 面板不显示时

- 油猴菜单提示“篡改猴没有访问此页面的权限”：在浏览器扩展详情中授予 `www.giseis.com` 网站访问权限，并刷新质检页面。
- 油猴管理面板的版本列仍是 1.6.4：重新安装／导入上面的 1.6.5 更新。旧版未匹配 `/html/M_CHK/Q_Check_Survey.html`。
- 管理面板找不到脚本：在当前浏览器和当前用户配置中完成脚本安装。
- 打开的是 GitHub、登录页面或 `/dashboard/workplace` 工作台：在实际质检页面或其匹配的 iframe 内检查助手是否出现。
- 以上设置正确仍不显示：提供完整质检地址、油猴管理面板版本及该页面 F12 控制台的报错，便于继续定位。

审核规则、参数和实现细节见 [技术文档](GISeis_测量质检助手_V1.6.4_技术文档.md)。
