# Gatenix — FREE Deploy Guide (Render + tumhara subdomain)

**Situation**: Hostinger support ne confirm kiya ki **Premium Web Hosting par Node.js app nahi chal sakti** —
uske liye Business/Cloud plan ya VPS chahiye (paid). Isliye ab plan ye hai:

> **App chalegi Render.com ke FREE tier par** (0₹, bina card), aur tumhara subdomain
> **gatenix.jobsalertsindia.com** ek CNAME record se Render se jud jayega.
> Domain tumhara hi rahega — duniya ko sirf `gatenix.jobsalertsindia.com` dikhega.

---

## Honest limitations (pehle se pata honi chahiye)

1. **Sleep mode**: Render free tier par app 15 min idle rahne par so jaati hai.
   Agli request par ~30 second mein wake hoti hai (pehla request slow, phir fast).
   Personal use ke liye acceptable hai.
2. **Database reset on redeploy**: Render free ki storage ephemeral hai — jab bhi tum
   app ko dobara deploy karoge, SQLite database reset ho jayegi.
   Admin account (`admin/admin123`) aur models **khud ban jaate hain** (auto-seed),
   par API tokens aur channel keys dobara daalne padenge.
   Roz-roz deploy nahi hoga, to personal use mein dikkat nahi.
3. Subdomain wali **WordPress ab bekaar hai** — hPanel → Auto Installer se delete kar do.

---

## Step 1 — GitHub account + repo (free)

1. [github.com](https://github.com) par free account banao (agar nahi hai)
2. Login → right-top **+** → **New repository**
3. Name: `gatenix` · **Private** ya Public (dono chalega) · **Create repository**
4. Repo banne ke baad GitHub "import" screen dikhayega — kuch mat karo, bas repo URL note karo:
   `https://github.com/TUMHARA-USERNAME/gatenix.git`

Project folder mein git already init+commit ho chuka hai (maine kar diya).
Ab Git Bash mein ye commands chalao (apna username):

```bash
cd /c/Users/DELL/.zcode/workspace/default/gatenix
git branch -M main
git remote add origin https://github.com/TUMHARA-USERNAME/gatenix.git
git push -u origin main
```

> Pehli baar push karne par GitHub login maangega — browser mein allow kar dena.

---

## Step 2 — Render par deploy (free)

1. [render.com](https://render.com) → **Get Started for Free** → **GitHub se sign up** karo (card nahi maangta)
2. Dashboard → **New → Web Service** → apni `gatenix` repo connect/select karo
3. Settings aise rakho:
   - **Name**: `gatenix`
   - **Region**: Singapore ya Mumbai (jo nearest lage)
   - **Runtime**: **Node**
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
4. **Create Web Service** dabao → 2-3 min mein deploy ho jayega
5. Deploy hone par tumhe URL milega: `https://gatenix-xxxx.onrender.com`
6. Test karo: `https://gatenix-xxxx.onrender.com/api/health` → `{"ok":true,"name":"Gatenix"}`

> Repo mein `render.yaml` already hai — Render kuch settings khud bhi utha lega.

---

## Step 3 — Subdomain ko Render se jodo (CNAME)

1. Hostinger **hPanel** → **Domains** → `jobsalertsindia.com` → **DNS / Nameservers** (DNS Zone Editor)
2. Naya record add karo:
   - **Type**: `CNAME`
   - **Name/Host**: `gatenix`
   - **Target/Points to**: `gatenix-xxxx.onrender.com` (apna Render URL, bina https://)
   - **TTL**: default (14400 ya 3600)
3. Save karo. DNS propagate hone mein 5 min se 24 ghante tak lag sakte hain (aksar 5-15 min).

> Agar `gatenix` naam ka koi purana A/AAAA/TXT record pehle se ho (WordPress time ka), use delete kar dena —
> sirf CNAME rehna chahiye.

---

## Step 4 — Verify + Security

1. Kholo: `https://gatenix.jobsalertsindia.com/` → Gatenix landing page
2. `https://gatenix.jobsalertsindia.com/api/health` → `{"ok":true,...}`
3. `https://gatenix.jobsalertsindia.com/dashboard` → Console
   Login: **admin / admin123** → **turant password badlo** (Profile → Change password)
4. Console mein:
   - **Channels** → TokenRouter / OpenRouter template → apni free API key paste karo
   - **Tokens** → naya API token banao (`sk-...`)
5. API test:
   ```bash
   curl https://gatenix.jobsalertsindia.com/v1/chat/completions \
     -H "Authorization: Bearer sk-XXXX" \
     -H "Content-Type: application/json" \
     -d '{"model":"mock-chat","messages":[{"role":"user","content":"hello"}]}'
   ```

SSL (https) Render khud laga dega — tumhe kuch nahi karna.

---

## ⭐ Database persistence (Supabase Storage — deploy se data reset NA ho)

Render free tier har deploy par disk saaf kar deta hai. App ab SQLite file ko automatically
**Supabase Storage** (free, bina card) par backup karti hai aur deploy ke baad restore kar leti hai.

**Setup (ek hi baar):**

1. [supabase.com](https://supabase.com) → **Start your project** → GitHub se sign up (free)
2. **New project** → naam `gatenix`, koi bhi password, region Singapore/Mumbai → ~1 min mein banega
3. Left menu → **Storage** → **New bucket** → naam: `gatenix-db` → private hi rehne do → Create
4. Left menu → **Project Settings** (gear icon) → **API Keys** → wahan se copy karo:
   - **Project URL** (jaise `https://xxxx.supabase.co`)
   - **service_role** wali key (secret key — `anon` wali NAHI)
5. Render → gatenix service → **Environment** → ye 3 variables add karo:
   - `SUPABASE_URL` = tumhara Project URL
   - `SUPABASE_SERVICE_KEY` = service_role key
   - `SUPABASE_BUCKET` = `gatenix-db`
6. Save → Render redeploy karega. Logs mein `[persist] cloud backup enabled` dikhega.

Uske baad har deploy par database khud restore hoga — channels, tokens, settings, users sab bachega.
Backup har 60 second mein (change hone par) aur shutdown par upload hota hai.

> Env vars daalne ke baad EK aakhri baar channels/settings dobara daalne padenge
> (pehla backup abhi khali hai). Uske baad kabhi dobara nahi karna.

---

## Future: agar kabhi Hostinger Business/Cloud lo

Tab app ko seedha Hostinger par bhi chala sakte ho (hPanel → Node.js section, unke naye plans mein
GitHub/zip deploy support hota hai). Par jab tak free mein kaam chal raha hai — Render best hai.
