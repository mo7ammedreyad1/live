import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

// 1. إعدادات البث (سحب مفتاح البث من متغيرات البيئة)
const STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "YOUR_STREAM_KEY_HERE";
const RTMP_DESTINATION = `rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}`;

const FPS = 30;
const FRAME_INTERVAL_MS = 1000 / FPS;

// 2. تشغيل سيرفر محلي خفيف على 127.0.0.1 لتفادي قيود الـ CORS
function startLocalServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let reqPath = decodeURIComponent(req.url.split('?')[0]);
            if (reqPath === '/' || reqPath === '') reqPath = '/scene.html';
            const filePath = path.join(process.cwd(), reqPath);
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not Found'); return; }
                res.writeHead(200); res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function startLiveStream() {
    console.log("==========================================");
    console.log("🚀 بدء محرك البث المباشر اللحظي إلى YouTube...");
    console.log("==========================================");

    const server = await startLocalServer();
    const port = server.address().port;

    console.log(`1. تشغيل المتصفح الخفي على http://127.0.0.1:${port}...`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-gl=swiftshader'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // توجيه سجلات المتصفح إلى التيرمينال لرؤية تقدم تحميل الصوت
    page.on('console', msg => console.log(`[Browser]: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[Browser Error]: ${err.message}`));

    console.log("2. فتح صفحة المشهد وبدء جلب الآيات والصوت...");
    
    // فتح الصفحة دون حظر الشبكة مع مهلة دقيقتين
    await page.goto(`http://127.0.0.1:${port}/scene.html`, { 
        waitUntil: 'domcontentloaded',
        timeout: 120000 
    });

    console.log("3. جاري انتظار اكتمال تحميل الصوت والخطوط وتجهيز الكانفاس...");
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });
    console.log("✓ تم اكتمال تجهيز المشهد بالكامل!");

    // 4. استخراج ملف الصوت ومزامنته
    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
        console.log("✓ تم حفظ ملف الصوت المؤقت للمزامنة اللحظية.");
    }

    // تشغيل حلقة العرض داخل المتصفح
    await page.evaluate(() => {
        if (typeof startPreviewLoop === 'function') startPreviewLoop();
    });

    // 5. تهيئة خط أنابيب FFmpeg للبث المباشر RTMP
    console.log("4. بدء تشغيل FFmpeg وضخ البث إلى YouTube...");
    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        // مدخل الفيديو من المتصفح
        '-f', 'image2pipe',
        '-r', String(FPS),
        '-i', '-',
        // مدخل الصوت
        ...(hasAudio ? ['-re', '-stream_loop', '-1', '-i', 'temp_live_audio.wav'] : []),
        // إعدادات البث المباشر لليوتيوب
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '4500k',
        '-maxrate', '4500k',
        '-bufsize', '9000k',
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS * 2),
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        RTMP_DESTINATION
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=') || msg.includes('bitrate=')) {
            process.stdout.write(`\r[Live RTMP]: ${msg.trim()}`);
        } else {
            console.log(`[FFmpeg]: ${msg.trim()}`);
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`\nانتهت جلسة البث بكود: ${code}`);
        browser.close();
        server.close();
        process.exit(code);
    });

    console.log("5. البث المباشر يعمل الآن على يوتيوب بنجاح (30 FPS) ✓");

    // 6. التقاط وضخ الفريمات اللحظية بدقة 30 فريم في الثانية
    let isCapturing = false;
    const interval = setInterval(async () => {
        if (isCapturing) return;
        isCapturing = true;

        try {
            const frameBase64 = await page.evaluate(() => {
                const cvs = document.getElementById('videoCanvas');
                return cvs ? cvs.toDataURL('image/jpeg', 0.88).split(',')[1] : null;
            });

            if (frameBase64 && ffmpeg.stdin.writable) {
                const buffer = Buffer.from(frameBase64, 'base64');
                ffmpeg.stdin.write(buffer);
            }
        } catch (err) {
            console.error("\nتنبيه في التقاط الفريم:", err.message);
        } finally {
            isCapturing = false;
        }
    }, FRAME_INTERVAL_MS);

    process.on('SIGINT', () => {
        console.log("\nإيقاف البث...");
        clearInterval(interval);
        ffmpeg.stdin.end();
        browser.close();
        server.close();
        process.exit(0);
    });
}

startLiveStream().catch((err) => {
    console.error("فشل تشغيل البث:", err);
    process.exit(1);
});
