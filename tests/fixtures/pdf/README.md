# PDF 测试样本

`two-page-text.pdf` 是 `scripts/pdf-smoke.mjs` 自生成的两页英文文字 PDF，仅包含 Helvetica 基础字体、页面内容流和交叉引用表；不含真实用户资料、模型密钥、图片、文档脚本或远程资源。

- 第 1 页：First PDF page、Reading English documents helps us learn. 等独立英文段落。
- 第 2 页：Second PDF page、The second page is translated only on demand. 等不同内容，用于验证不会预取或串页。
- 自行编写的测试文字，可随本项目再分发。

重新生成，不启动浏览器：

```powershell
node scripts/pdf-smoke.mjs --fixture-only
```

真实 Chrome 集成测试（独立临时浏览器配置，真实 PDF.js/Worker，仅模型 API 为模拟）：

```powershell
node scripts/pdf-smoke.mjs
```

可通过 `CHROME_PATH` 指定 Chrome 可执行文件。样本仅覆盖最小文字 PDF 闭环，不代表复杂版面、加密文档或扫描件兼容性。
