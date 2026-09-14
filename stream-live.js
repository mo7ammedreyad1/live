import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

// 1. إعدادات البث ومفتاح يوتيوب
const STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "YOUR_STREAM_KEY_HERE";
const RTMP_DESTINATION = `rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}`;

const FRAME_BATCH_SIZE = 24;

// سيرفر محلي نظيف يمنع أخطاء الـ 404 والـ Favicon
function startLocalServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let reqPath = decodeURIComponent(req.url.split('?')[0]);
            if (reqPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
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

function writeWithBackpressure(stream, buffer) {
    return new Promise((resolve, reject) => {
        const ok = stream.write(buffer, (err) => { if (err) reject(err); });
        if (ok) resolve();
        else stream.once('drain', resolve);
    });
}

async function runLivePipeline() {
    console.log("==========================================================");
    console.log("🌟 محرك البث المباشر الذكي (Dual-Stage Live Engine)");
    console.log("==========================================================");

    // =========================================================================
    // المرحلة الأولى: تجهيز كبسولة البث الأصلية (بدون إسقاط أي فريم)
    // =========================================================================
    console.log("\n[المرحلة 1]: جلب الآيات والصوت وتجهيز كبسولة البث بدقة 100%...");
    const server = await startLocalServer();
    const port = server.address().port;

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

    page.on('console', msg => console.log(`[Browser Console]: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[Browser Error]: ${err.message}`));

    await page.goto(`http://127.0.0.1:${port}/scene.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });

    // استخراج الصوت
    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
    }

    const totalFrames = await page.evaluate(() => window.__ofoqTotalFrames);
    const fps = await page.evaluate(() => window.__ofoqFps || 30);
    const streamSourceFile = 'live_stream_source.mp4';

    console.log(`\n✓ جاري رندرة المشهد (${totalFrames} فريم @ ${fps} FPS) بدون أي تقطيع...`);

    const preEncodeArgs = [
        '-y',
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-framerate', String(fps),
        '-i', '-',
        ...(hasAudio ? ['-i', 'temp_live_audio.wav'] : []),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-g', String(fps * 2),
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : []),
        streamSourceFile
    ];

    const preFfmpeg = spawn('ffmpeg', preEncodeArgs);
    preFfmpeg.stderr.on('data', d => console.error(`[Pre-Encode FFmpeg]: ${d.toString()}`));

    let lastPercent = -1;
    for (let start = 0; start < totalFrames; start += FRAME_BATCH_SIZE) {
        const count = Math.min(FRAME_BATCH_SIZE, totalFrames - start);
        const batch = await page.evaluate(([s, c]) => window.__ofoqGetFrameBatch(s, c), [start, count]);
        for (const base64Frame of batch) {
            await writeWithBackpressure(preFfmpeg.stdin, Buffer.from(base64Frame, 'base64'));
        }
        const percent = Math.round(((start + count) / totalFrames) * 100);
        if (percent !== lastPercent) {
            process.stdout.write(`\r[تجهيز البث]: فريم ${start + count}/${totalFrames} (${percent}%) ✓`);
            lastPercent = percent;
        }
    }

    preFfmpeg.stdin.end();
    await new Promise(resolve => preFfmpeg.on('close', resolve));
    await browser.close();
    server.close();

    console.log("\n✓ اكتمل تجهيز كبسولة البث بجودة فائقة وفريمات كاملة 30.00 FPS!");

    // =========================================================================
    // المرحلة الثانية: انطلاق البث المباشر إلى YouTube RTMP بتكرار لا نهائي
    // =========================================================================
    console.log("\n==========================================================");
    console.log("🔴 [المرحلة 2]: انطلاق البث المباشر الآن على YouTube 24/7...");
    console.log("==========================================================");

    const liveArgs = [
        '-re',                        // قراءة بالزمن الحقيقي الصارم 1.00x
        '-stream_loop', '-1',         // تكرار لا نهائي سلس للأبد
        '-i', streamSourceFile,       // كبسولة المشهد الجاهزة
        '-c:v', 'copy',               // تمرير مباشر للفيديو بدون استهلاك معالج (CPU ~ 0%)
        '-c:a', 'copy',               // تمرير مباشر للصوت بنقاء 100%
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        RTMP_DESTINATION
    ];

    const liveFfmpeg = spawn('ffmpeg', liveArgs);

    liveFfmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        // إظهار لوج حي وتفصيلي في تيرمينال GitHub Actions
        if (msg.includes('frame=') || msg.includes('bitrate=')) {
            process.stdout.write(`\r[YouTube Live 🔴]: ${msg.trim()}`);
        } else if (msg.toLowerCase().includes('error')) {
            console.error(`\n[RTMP Error]: ${msg.trim()}`);
        }
    });

    liveFfmpeg.on('close', (code) => {
        console.log(`\nانتهت جلسة البث بكود: ${code}`);
        process.exit(code);
    });

    process.on('SIGINT', () => {
        console.log("\nإيقاف البث المباشر...");
        liveFfmpeg.kill('SIGINT');
        process.exit(0);
    });
}

runLivePipeline().catch(err => {
    console.error("\nخطأ فادح في البث:", err);
    process.exit(1);
});
