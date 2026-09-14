import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

// 1. رابط البث الخاص باليوتيوب (يُسحب تلقائياً من GitHub Secrets أو يوضع يدوياً)
const STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "YOUR_STREAM_KEY_HERE";
const RTMP_DESTINATION = `rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}`;

const FPS = 30;
const FRAME_INTERVAL_MS = 1000 / FPS;

// 2. تشغيل سيرفر محلي خفيف لتفادي مشاكل الـ CORS في Chrome
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
        server.listen(0, () => resolve(server));
    });
}

async function startLiveStream() {
    console.log("==========================================");
    console.log("🚀 بدء محرك البث المباشر اللحظي إلى YouTube...");
    console.log("==========================================");

    const server = await startLocalServer();
    const port = server.address().port;

    console.log(`1. تشغيل المتصفح الخفي على المنفذ: ${port}...`);
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

    console.log("2. فتح صفحة المشهد والتأكد من الجاهزية...");
    await page.goto(`http://localhost:${port}/scene.html`, { waitUntil: 'networkidle0' });

    // انتظار جاهزية المشهد بالكامل
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 60000 });
    console.log("✓ تم تحميل الخطوط والأصول الصوتية وتجهيز الكانفاس بنجاح!");

    // 3. استخراج ملف الصوت لمزامنته مع البث
    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
        console.log("✓ تم استخراج الصوت وتجهيزه للمزامنة اللحظية.");
    }

    // تشغيل حلقة العرض اللحظية داخل المتصفح
    await page.evaluate(() => {
        if (typeof startPreviewLoop === 'function') startPreviewLoop();
    });

    // 4. إعداد خط أنابيب FFmpeg للبث المباشر RTMP
    console.log("3. تهيئة خط أنابيب FFmpeg المتصل بـ YouTube RTMP...");
    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        // مدخل الفيديو (فريمات مباشرة من stdin)
        '-f', 'image2pipe',
        '-r', String(FPS),
        '-i', '-',
        // مدخل الصوت (تشغيل وقراءة بالسرعة الحقيقية مع تكرار لا نهائي)
        ...(hasAudio ? ['-re', '-stream_loop', '-1', '-i', 'temp_live_audio.wav'] : []),
        // إعدادات ترميز الفيديو (H.264 Ultra-Low Latency)
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '4500k',
        '-maxrate', '4500k',
        '-bufsize', '9000k',
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS * 2), // فريم مفتاحي كل ثانيتين (شرط يوتيوب)
        // إعدادات ترميز الصوت
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        RTMP_DESTINATION
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=') || msg.includes('bitrate=')) {
            process.stdout.write(`\r[FFmpeg RTMP]: ${msg.trim()}`);
        } else {
            console.log(`[FFmpeg]: ${msg.trim()}`);
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`\nانتهت جلسة FFmpeg بكود: ${code}`);
        browser.close();
        server.close();
        process.exit(code);
    });

    console.log("4. بدء ضخ الفريمات اللحظية إلى YouTube Live (30 FPS)...");

    // 5. حلقة الالتقاط والضخ الزمني الثابت (Clock-Synced Loop)
    let isCapturing = false;
    const interval = setInterval(async () => {
        if (isCapturing) return; // تخطي الفريم إذا كان المتصفح مشغولاً لتفادي تراكم الـ Lag
        isCapturing = true;

        try {
            // التقاط فريم الكانفاس مباشرة كـ Buffer
            const frameBase64 = await page.evaluate(() => {
                const cvs = document.getElementById('videoCanvas');
                return cvs.toDataURL('image/jpeg', 0.88).split(',')[1];
            });

            if (frameBase64) {
                const buffer = Buffer.from(frameBase64, 'base64');
                ffmpeg.stdin.write(buffer);
            }
        } catch (err) {
            console.error("\nخطأ في التقاط الفريم:", err.message);
        } finally {
            isCapturing = false;
        }
    }, FRAME_INTERVAL_MS);

    // إيقاف البث بنظافة عند الضغط على Ctrl+C
    process.on('SIGINT', () => {
        console.log("\nجاري إيقاف البث المباشر...");
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
