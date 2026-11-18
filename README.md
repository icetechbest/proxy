# Simple Web Proxy

## المتصفح (الصفحة الرئيسية)
تابات متعددة، شريط عنوان، رجوع/تقدم/تحديث، مفضلة وسجل، واستعادة التابات بعد التحديث.
اختصارات: Alt+T تاب جديد، Alt+W قفل، Alt+L العنوان، Alt+1..9 تبديل.

## تشغيل
    node server.js            # http://localhost:3000

## متغيرات البيئة
| المتغير | الوصف |
|---|---|
| PORT | البورت (3000) |
| ACCESS_KEY | كلمة سر للدخول (موصى بيها جداً) |
| RATE_LIMIT | طلبات/دقيقة لكل IP (150) |
| BLOCKLIST | دومينات محظورة مفصولة بفاصلة (أو في blocklist.txt) |
| TRUST_PROXY | 1 لو خلف Nginx |
| MAX_REWRITE_MB / TIMEOUT_MS | حدود الحجم والمهلة |

## وضع الـ Subdomain (عزل كل موقع في دومين فرعي)
    BASE_DOMAIN=proxy.example.com TRUST_PROXY=1 node server.js
محتاج: DNS wildcard (`*.proxy.example.com` → السيرفر) + شهادة wildcard (certbot --dns-<provider> -d proxy.example.com -d "*.proxy.example.com").
متغيرات إضافية: PUBLIC_SCHEME (https) / PUBLIC_PORT (للتطوير) / SECRET.
في Nginx خلي `server_name proxy.example.com *.proxy.example.com;` وأضف:
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # WebSocket

## WebSocket
مدعوم في الوضعين (path و subdomain) تلقائياً.

## وضع Ultraviolet (مجلد uv/ - غير مختبر)
    cd uv && npm install && npm start     # http://localhost:8080
محتاج HTTPS في الإنتاج (Service Worker). لو اتغيرت واجهة UV في إصدار أحدث، راجع توثيق Titanium Network.

## Docker
    docker build -t webproxy .
    docker run -d -p 3000:3000 -e ACCESS_KEY=secret --restart unless-stopped webproxy

## Nginx + SSL
    server {
      listen 443 ssl http2; server_name proxy.example.com;
      # certbot --nginx -d proxy.example.com
      location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;
      }
    }
