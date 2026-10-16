# برج بلاي — محاكي PS2 في المتصفح

واجهة جديدة لمحاكي **[Play!](https://github.com/jpd002/Play-)** مفتوح المصدر (رخصة BSD-2)، مجمّع من المصدر إلى WebAssembly ويعمل كاملًا داخل المتصفح دون تثبيت ودون ملف BIOS.

**جرّبه الآن:** https://cmkrfd2r77-hue.github.io/play-tower/

## ما الذي أُضيف على Play! الأصلي

الواجهة الرسمية للمتصفح (playjs.purei.org) فيها زر اختيار ملف وعدّاد إطارات فقط. هنا:

| الميزة | التفاصيل |
|---|---|
| مكتبة ألعاب تلقائية | أضف مجلدًا فيُفحص كل قرص: يُقرأ `SYSTEM.CNF` من داخل ISO/BIN/CSO لمعرفة رقم القرص (مثل `SLUS-20062`)، ثم الاسم والمنطقة من قاعدة PCSX2 (أكثر من 12 ألف لعبة)، والغلاف من مستودع xlenore/ps2-covers، ومدى التوافق من متتبّع Play!. ملفات CHD/ISZ تُعرَّف من اسم الملف. |
| ألعاب من GitHub | ألعاب Homebrew مفتوحة المصدر تُنزَّل بنقرة وتُحفظ في المتصفح. ويمكن إضافة أي مستودع عام (`owner/repo`) ليُفحص بحثًا عن ملفات ELF/ISO. |
| يد التحكم | Gamepad API لاعبَين اثنين، مع التنقل في الواجهة نفسها بيد التحكم (✕ تشغيل، △ مفضلة، START الإعدادات، زر PS قائمة الإيقاف). |
| لوحة المفاتيح | كل الأزرار قابلة لإعادة التعيين. الافتراضي: الأسهم للاتجاهات، K/L/J/I للأزرار ✕/○/□/△، WASD للعصا اليسرى. |
| أزرار لمس | على الهاتف: اتجاهات، عصا تناظرية، أزرار الوجه والكتف، مع شفافية قابلة للتعديل. |
| حفظ الحالات | 4 خانات لكل لعبة مع صورة مصغّرة، وحفظ/تحميل سريع (F5 / F8). |
| بطاقة الذاكرة دائمة | مجلد بيانات Play! محفوظ في IndexedDB، فتبقى حفظات الألعاب بعد إغلاق الصفحة. |
| إيقاف مؤقت وتسريع | قائمة إيقاف (Esc)، وتسريع بإلغاء حدّ الإطارات (Tab)، وإيقاف تلقائي عند إخفاء التبويب. |
| صورة أوضح | دقة داخلية حتى 4×، ونسب 4:3 أو 16:9 أو ملء الشاشة، وملء الشاشة الكامل، ولقطات شاشة. |
| يعمل على GitHub Pages | Service worker يضيف ترويسات العزل (COOP/COEP) اللازمة لـ SharedArrayBuffer، ويخزّن النواة للعمل دون اتصال. |

### تعديلات على نواة Play! نفسها

الملف [`core/play-js-api.patch`](core/play-js-api.patch) يحوي كل التعديلات على المصدر الأصلي (الإصدار `d44bfa1`):

- **إدخال افتراضي من JavaScript** لكل أزرار يدَي تحكم بدل لوحة مفاتيح ثابتة على الـ canvas.
- **واجهات جديدة**: `pauseVm` و`resumeVm` (غير حاجبة للخيط الرئيسي)، و`saveState`/`loadState`/`getStateResult`، و`setOutputSize`، و`setResolutionFactor`، و`setPresentationMode`، و`setFrameLimit`، و`setVolume`، و`getVersion`.
- **إصلاح توافق في محاكاة GS**: برامج Homebrew المبنية بـ ps2sdk قديم كانت تتجمّد بعد الإطار الأول، لأن `graph_wait_vsync` يمسح حدث FINISH الذي يضبطه Play! فورًا، فينتظر `draw_wait_finish` إلى الأبد. صار الحدث يظهر بعد بضع قراءات لـ CSR عندما تكون مقاطعته مقنّعة، كما على الجهاز الحقيقي. بهذا تعمل Dungeon Game وبقية عروض glampert.
- **تشغيل ألعاب تقرأ ملفاتها من USB**: `bootVirtualElf` يمرّر وسائط للبرنامج، و`setHostDirectory` يحدّد مجلد `host:`، وصار `mass:` و`cdfs:` متاحين أيضًا.
- **إصلاح مؤقّت EE**: حدث المقارنة كان يضيع عندما يلتف العدّاد في الخطوة نفسها (يؤثّر على `DelayThread` في ps2sdk).
- `preserveDrawingBuffer` لالتقاط الصور، و IDBFS لحفظ البيانات.

## ألعاب مفتوحة المصدر جاهزة

ملفاتها موجودة في مجلد [`games/`](games) وتظهر في المتجر بنقرة تثبيت واحدة. كل لعبة معها رخصتها وملف `SOURCE.md` يشير إلى المصدر الدقيق.

| اللعبة | الملفات | الرخصة |
|---|---|---|
| **Quake** (محرك QuakeSpasm، نقل [glampert/quake-ps2](https://github.com/glampert/quake-ps2)) مع بيانات [LibreQuake](https://github.com/lavenderdotpet/LibreQuake) الحرة | `games/quake/quake.elf` + `games/quake/id1.zip` | GPL-2.0 للمحرك، BSD-3 للبيانات |
| **SuperTux** 0.1.1 (نقل [headshot2017/supertux-ps2](https://github.com/headshot2017/supertux-ps2)) | `games/supertux/supertux.elf` + `games/supertux/data.zip` | GPL-2.0 |

ملفات البيانات (`.zip`) تُفك في ذاكرة المتصفح عند كل تشغيل وتظهر للعبة على `host:` و`mass:`، مثل مجلد على ذاكرة USB في الجهاز الحقيقي.

## ملاحظة قانونية

البرج لا ينزّل ألعابًا تجارية. شغّل نسخًا صنعتها بنفسك من أقراصك. ألعاب المتجر كلها مفتوحة المصدر ومسموح بتوزيعها (مثل [glampert/ps2-homebrew](https://github.com/glampert/ps2-homebrew) برخصة MIT، وQuake مع بيانات LibreQuake الحرة بدل بيانات id Software التجارية). الأغلفة تُعرض مباشرة من مستودعها على GitHub ولا تُنسخ هنا.

## الملفات

```
  index.html, styles.css    الواجهة
  sw.js                     العزل والتخزين المؤقت
  js/main.js                تحكم الواجهة (المكتبة، المتجر، المشغّل، الإعدادات)
  js/emulator.js            غلاف النواة: التحميل، IDBFS، الحالات، الصورة
  js/disc.js                قراءة الأقراص مع ذاكرة مؤقتة، واستخراج رقم القرص
  js/zip.js                 فك حزم بيانات الألعاب (.zip) قبل التشغيل
  js/library.js             المكتبة: المجلدات، الملفات، GitHub
  js/input.js               لوحة المفاتيح، يد التحكم، اللمس
  js/gamedb.js              الأسماء والأغلفة والتوافق
  js/towers.js              خلفية الأبراج ومشهد الإقلاع
  js/i18n.js                العربية والإنجليزية
  core/                     Play.js و Play.wasm المبنيان من المصدر + الرقعة + الرخصة
  data/gamedb.json          قاعدة الألعاب (من PCSX2 GameIndex)
  data/homebrew.json        قائمة ألعاب المتجر
  games/                    ألعاب مفتوحة المصدر مع بياناتها ورخصها (Quake، SuperTux)
```

## التحديث التلقائي

`.github/workflows/update.yml`:
- أسبوعيًا: يحدّث `data/gamedb.json` و`data/compat.json` من GitHub (عبر `tools/build_gamedb.py` و`tools/build_compat.py`) ثم يعيد نشر الموقع.
- يدويًا (Actions ← Update game data and core ← Run workflow ← rebuild_core): يبني النواة من مصدر Play! مع الرقعة ويستبدل `core/`.

الموقع يُنشر بـ GitHub Pages مباشرة من فرع `gh-pages` (ملف `.nojekyll` يمنع معالجة Jekyll).

## البناء يدويًا

```bash
git clone --recursive https://github.com/jpd002/Play-.git && cd Play-
git checkout d44bfa1814b729d4a3ed3c6c3a945432d5ee5bbe && git submodule update --init --recursive
git apply /path/to/play-tower/core/play-js-api.patch
emcmake cmake --preset wasm-ninja          # emsdk 4.0.1
cmake --build --preset wasm-ninja-release --target Play
cp build_cmake/build/wasm-ninja/Source/ui_js/Release/Play.{js,wasm} /path/to/play-tower/core/
```

للتجربة محليًا يكفي أي خادم ثابت على `localhost` (الـ service worker يضيف الترويسات)، مثل `npx serve .` ثم افتح `http://localhost:3000/`.

## الرخص والمصادر

- نواة المحاكي: [Play!](https://github.com/jpd002/Play-) © Jean-Philip Desjardins، رخصة BSD-2 (نصها في [`core/LICENSE-Play.txt`](core/LICENSE-Play.txt)). التعديلات عليها في [`core/play-js-api.patch`](core/play-js-api.patch).
- أسماء الألعاب ومناطقها: [PCSX2 GameIndex](https://github.com/PCSX2/pcsx2).
- التوافق: [Play-Compatibility](https://github.com/jpd002/Play-Compatibility).
- الأغلفة: [xlenore/ps2-covers](https://github.com/xlenore/ps2-covers) (تُعرض من مستودعها مباشرة ولا تُنسخ هنا).
- ألعاب Homebrew: [glampert/ps2-homebrew](https://github.com/glampert/ps2-homebrew) (MIT)، تُنزَّل من مستودعها عند الطلب.
