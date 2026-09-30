<!-- Pull request checklist — see CONTRIBUTING.md for the full conventions / 完整约定见 CONTRIBUTING.md -->

**What & why / 做了什么、为什么**

<!-- One or two paragraphs: the change itself and the motivation (linked issues welcome).
     一两段话：改动本身与动机（欢迎附 issue 链接）。 -->

**Verification / 验证**

<!-- Check what you ran; the full matrix for risky areas is in CONTRIBUTING.md.
     勾选实际跑过的项；高风险改动的完整验证矩阵见 CONTRIBUTING.md。 -->

- [ ] `npm run typecheck` — 0 errors / 0 错误
- [ ] `npm run smoke` — SMOKE_OK
- [ ] New/changed behavior covered by an e2e suite（suite name / 套件名）: `--e2e-…`
- [ ] Regression suites for touched areas（改动面回归）: `--e2e-…`
- [ ] Docs updated（README / CHANGELOG / docs 双语同步）

**Notes for reviewers / 给评审的备注**

<!-- Non-obvious design decisions, trade-offs, follow-ups.
     不明显的设计取舍、权衡与后续事项。 -->
