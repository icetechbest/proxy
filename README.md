# Legacy Proxy — متصفح بروكسي بمفاتيح ولوحة أدمن

متصفح ويب فوق البروكسي: تابات، مفضلة، سجل، بحث (DuckDuckGo أو SearXNG بتاعك)، وكل الروابط بتتفتح جوه البروكسي.

## النشر على Railway (خطوة بخطوة)
1. ارفع المشروع على GitHub (من غير `node_modules`)، وفي Railway: **New Project → Deploy from GitHub repo**. بيتبني تلقائي من `Dockerfile`.
2. **Variables**: ضيف `ADMIN_KEY` = كلمة سر طويلة (دي كلمة سر لوحة الأدمن).
3. **Volume** (مهم!): من الـ service اضغط **Add Volume** وخلي الـ Mount Path = `/data`. من غيره المفاتيح بتتمسح كل redeploy.
4. **Settings → Networking → Generate Domain**.
5. افتح `https://دومينك/_admin` ← ادخل بـ `ADMIN_KEY` ← أنشئ مفاتيح.
6. العميل يفتح `https://دومينك/` ويدخل بالمفتاح بس.

## لوحة الأدمن (`/_admin`)
- إنشاء مفتاح باسم + مدة (أيام) + أقصى عدد أجهزة. المفتاح بيظهر **مرة واحدة** (متخزن مشفّر SHA-256).
- تعطيل/تفعيل، تمديد 30 يوم، تصفير الأجهزة (بيطرد الجلسات), حذف. التعطيل والحذف بيقطعوا الجلسة فوراً.
- إحصائيات: عدد الأجهزة، الطلبات، آخر استخدام وIP.
- حماية: 8 محاولات غلط/10 دقايق لكل IP، كوكي الأدمن `Strict`، ورأس CSRF على كل طلبات الـ API.
- `ADMIN_KEY` نفسه بيدخّلك للبروكسي كمان.

## تحسينات المتصفح
- **تعديل الجافاسكربت (AST بـ acorn):** `location` / `window.location` / `document.location` / `top.location` بترجّع عنوان الموقع الحقيقي، وأي `location.href=...` بيفضل جوه البروكسي. التعديل مش بيلمس النصوص والتعليقات والـ regex، ولو فشل بيرجّع الكود الأصلي. `JS_REWRITE=0` يوقفه، و`JS_BYPASS=site.com` يتخطى مواقع معينة.
- **Service Worker (`/sw.js`):** أي طلب خرج بعنوان خام (موقع خارجي، `fetch(new Request(..))`، مسار نسبي، Workers و`importScripts`) بيتحوّل لطلب بروكسي. شغال في وضع الـ path فقط (وضع Railway).
- **كوكيز دايمة:** الكوكيز بتتحفظ في `DATA_DIR/cookies.json` فمفيش تسجيل خروج بعد الريستارت.
- **فيديو/صوت:** مهلة 3 دقايق، دعم `Range` و`If-Range`، وبدون ضغط للطلبات اللي فيها range.
- **فك روابط التتبع** بتاعة DuckDuckGo وGoogle وBing، والتابات والـ Ctrl/Middle click والفورمات كلها جوه البروكسي.

## SearXNG (اختياري)
1. على Railway ضيف service من Docker image `searxng/searxng`، وفي `settings.yml` فعّل `search: formats: [html, json]`.
2. في service البروكسي: `SEARXNG_URL=http://<اسم-الخدمة>.railway.internal:8080`.
3. هيظهر خيار "SearXNG (بتاعي)" في قايمة البحث كافتراضي، والنتايج بتتفتح جوه البروكسي.

## متغيرات البيئة
| المتغير | الوصف |
|---|---|
| `ADMIN_KEY` | **إجباري على السيرفر العام.** من غيره الموقع مفتوح للكل واللوحة معطّلة |
| `PORT` | بيحطه Railway تلقائي |
| `DATA_DIR` | مكان المفاتيح والكوكيز (تلقائي: Volume بتاع Railway أو `./data`) |
| `SEARXNG_URL` | عنوان SearXNG |
| `JS_REWRITE` / `JS_BYPASS` / `JS_MAX_MB` | التحكم في تعديل الجافاسكربت (افتراضي on، 4MB) |
| `RATE_LIMIT` | طلبات/دقيقة لكل IP (900) |
| `BLOCKLIST` | دومينات محظورة (أو `blocklist.txt`) |
| `TRUST_PROXY` | تلقائي على Railway |
| `BASE_DOMAIN` | وضع الـ subdomain (محتاج wildcard DNS، مش متاح على دومين Railway العادي) |

## تشغيل محلي
    npm install
    ADMIN_KEY=secret node server.js      # http://localhost:3000  ←  /_admin

## ملاحظات
- مجلد `uv/` قديم وتجريبي ومش مستخدم (متستبعد من الـ Docker).
- الكوكيز اللي الـ JS بيقراها (`document.cookie`) مش متزامنة مع كوكيز السيرفر. ومواقع محمية بشدة (تسجيل دخول بـ captcha أو DRM) ممكن ما تشتغلش.
