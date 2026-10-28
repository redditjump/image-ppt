# 操作说明

## 运行环境

以实际发现的 Node 可执行文件运行 scripts/deck.cjs。`--modules` 指向可用的 node_modules；或在项目目录安装 `pptxgenjs`，让脚本从项目解析依赖。只有请求轻量版时才需要 `sharp`。脚本不依赖其他幻灯片技能。

检查安装包：`node <skill>/scripts/deck.cjs doctor --project <项目> --modules <node_modules>`。
若当前应用能查询 workspace dependencies，优先使用它返回的路径。不要复制其他电脑的缓存路径。需要独立安装时：在项目目录执行 `npm.cmd install pptxgenjs`，轻量版另安装 `sharp`。

## 项目和清单

`init` 仅创建不存在的新目录，包括素材、参考图、逐页提示词、图片、脚本、输出和历史记录目录，以及 brief、outline、style-guide、progress、AGENTS 和 manifest 文件。

清单版本1：

```json
{
  "schema_version": 1,
  "title": "产品介绍",
  "slides": [
    {
      "id": "offer",
      "title": "现场订购",
      "image": "renders/offer-v2.png",
      "prompt": "prompts/offer-v2.md",
      "notes": "已确认文案及素材来源，可写讲者备注。"
    }
  ]
}
```

图片支持 PNG/JPG/JPEG。路径相对项目根目录；文件必须存在且解析后仍位于项目内。先将外部图片复制到项目，再登记。id 为小写字母开头的小写字母、数字或短横线，最长64字符且唯一。title 必填。prompt、notes 可省略；登记 prompt 后须存在。

数组顺序就是演示顺序。id 不随插页变化，不按图片文件名排序。脚本固定输出16:9，非16:9图会提示并完整居中放入白底，不裁切或拉伸。最好在生成阶段就准备16:9图片。

## 命令

以下 `<cli>` 代表技能脚本绝对路径，`<project>` 代表项目目录。路径和中文标题有空格时加引号。

```text
node <cli> init --project <project> --title "产品介绍"
node <cli> doctor --project <project> --modules <node_modules>
node <cli> list --project <project>
node <cli> check --project <project>

node <cli> add --project <project> --id cover --title "封面" --image renders/cover.png --prompt prompts/cover.md
node <cli> add --project <project> --id case --title "客户案例" --image renders/case.png --after cover
node <cli> add --project <project> --id opening --title "开场" --image renders/opening.png --first
node <cli> replace --project <project> --id case --image renders/case-v2.png --prompt prompts/case-v2.md
node <cli> remove --project <project> --id case

node <cli> build --project <project> --modules <node_modules> --compact
```

add 默认追加；`--first` 和 `--after` 互斥。replace 仅更新指定图片、可选标题/提示词/备注，保留 id 和顺序。用 `--notes "..."` 设置备注。

check/list 不更改文件。add/replace/remove 每次先备份 manifest 到 revisions，再更新。remove 不删除图片或提示词。

build 可带 `--version v001`（仅字母、数字、短横线、下划线）；不指定则生成时间戳加随机后缀。已有版本拒绝覆盖。`--quality 90` 设置轻量 JPEG 品质（60–100），默认90，轻量图限制在1920×1080内且不放大。透明图片在轻量版合成白底。高清版使用原图。

发布目录：

```text
output/<version>/
  deck-hd.pptx
  deck-compact.pptx         仅 --compact 时
  images/                  独立复制的高清图片
  images-compact/          仅 --compact 时
  prompts/                 已登记提示词的副本
  preview/index.html       离线翻页，方向键/空格/Home/End
  manifest.json            可验证的发布快照，图片路径指向发布内副本
  build.json               页码/id/标题、源图与成品SHA256、实际文件清单
output/LATEST.json         最近一次成功发布的路径和文件名
```

每次构建放入独立临时发布目录，全部成功后再改成正式目录并更新 LATEST。失败不会替换旧成品，临时目录保留以便检查。构建复制图片到发布目录，因此以后替换项目源图片不影响旧发布的预览。

同一项目的写入命令使用排他锁 `.image-ppt.lock`；如果进程异常中断，确认没有构建在运行后才能移走残留锁。不要为了并行任务绕过锁。

## 任务提示词

新稿：

> 使用 $image-ppt，在指定项目制作图片版PPT。主题、受众、用途、页数和参考附件如下……先整理大纲并制作三页样张，确认后生成整套。保留原始素材、逐页提示词和高清图片，交付高清版、轻量版PPT及预览。

修改：

> 使用 $image-ppt，继续指定项目。读取最新记录，核对第X页“标题”。把“旧文案”改为“新文案”，使用当前成稿作编辑目标，检查其他内容是否保持一致。保存新候选，通过后更新页面清单并生成新发布。

接续：

> 读取项目AGENTS、brief、style-guide、manifest、progress和output/LATEST.json，继续已确认的图片版PPT流程。本次修改是……
