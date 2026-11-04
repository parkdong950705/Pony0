const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const metaFile = path.join(__dirname, 'metadata.json');
const IMAGE_REGEX = /\.(jpg|jpeg|png|gif|webp)$/i;

/* ───────────── GitHub 연동 설정 ───────────── */
const GH = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main'
};

function ghEnabled() {
    return Boolean(GH.token && GH.owner && GH.repo);
}

function ghUrl(repoPath) {
    const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encoded}`;
}

function ghHeaders() {
    return {
        Authorization: `Bearer ${GH.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ffx-cloud-studio'
    };
}

// 동시 요청 시 sha 충돌(409)이 나지 않도록 GitHub 작업을 순서대로 실행
let ghChain = Promise.resolve();
function ghEnqueue(task) {
    const run = ghChain.then(task);
    ghChain = run.catch(() => {});
    return run;
}

async function ghPutFile(repoPath, contentBuffer, message) {
    let sha;
    const head = await fetch(`${ghUrl(repoPath)}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (head.ok) sha = (await head.json()).sha;

    const res = await fetch(ghUrl(repoPath), {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
            message,
            content: contentBuffer.toString('base64'),
            branch: GH.branch,
            ...(sha && { sha })
        })
    });
    if (!res.ok) throw new Error(`GitHub PUT 실패: ${res.status} ${await res.text()}`);
}

async function ghDeleteFile(repoPath, message) {
    const head = await fetch(`${ghUrl(repoPath)}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (!head.ok) return; // 깃허브에 없으면 무시
    const { sha } = await head.json();

    const res = await fetch(ghUrl(repoPath), {
        method: 'DELETE',
        headers: ghHeaders(),
        body: JSON.stringify({ message, sha, branch: GH.branch })
    });
    if (!res.ok) throw new Error(`GitHub DELETE 실패: ${res.status} ${await res.text()}`);
}

// 서버 시작 시 uploads 폴더가 비어 있으면 GitHub에서 복원
async function restoreFromGitHub() {
    if (!ghEnabled()) return;
    if (fs.readdirSync(uploadsDir).length > 0) return;

    console.log('📥 GitHub에서 데이터 복원 시도...');

    const listRes = await fetch(`${ghUrl('uploads')}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (listRes.ok) {
        const items = await listRes.json();
        for (const item of items) {
            if (item.type !== 'file') continue;
            const blobRes = await fetch(item.git_url, { headers: ghHeaders() });
            if (!blobRes.ok) continue;
            const blob = await blobRes.json();
            fs.writeFileSync(path.join(uploadsDir, item.name), Buffer.from(blob.content, 'base64'));
        }
    }

    const metaRes = await fetch(`${ghUrl('metadata.json')}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta.content) {
            fs.writeFileSync(metaFile, Buffer.from(meta.content, 'base64'));
        }
    }
    console.log('✅ GitHub 복원 완료');
}

/* ───────────── 메타데이터 ───────────── */
function loadMetadata() {
    try {
        if (fs.existsSync(metaFile)) {
            return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        }
    } catch (e) {
        console.error('메타데이터 로드 실패:', e);
    }
    return {};
}

function saveMetadata(data) {
    try {
        fs.writeFileSync(metaFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('메타데이터 저장 실패:', e);
    }
}

/* ───────────── 업로드 설정 ───────────── */
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, path.basename(decodedName));
    }
});
const upload = multer({ storage });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'ffx-panel')));

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'style.css'));
});

app.get('/main.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'main.js'));
});

/* ───────────── 프리셋 목록 조회 ───────────── */
app.get('/api/presets', (req, res) => {
    try {
        if (!fs.existsSync(uploadsDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(uploadsDir);
        const effectFiles = files.filter(file => !file.match(IMAGE_REGEX));
        const imageFiles = files.filter(file => file.match(IMAGE_REGEX));
        const metadata = loadMetadata();

        let presets = [];
        let idCounter = 1;

        effectFiles.forEach((file, index) => {
            const baseName = path.parse(file).name;
            let thumbFile = 'default-thumb.png';

            const exactThumb = imageFiles.find(f => path.parse(f).name === baseName);
            if (exactThumb) {
                thumbFile = exactThumb;
            } else if (imageFiles[index]) {
                thumbFile = imageFiles[index];
            } else if (imageFiles.length > 0) {
                thumbFile = imageFiles[0];
            }

            const category = metadata[file] || metadata[baseName] || 'motion';

            presets.push({
                id: idCounter++,
                NAME: file,
                THUMBNAIL: thumbFile,
                CATEGORY: category
            });
        });

        const matchedThumbnames = presets.map(p => p.THUMBNAIL);
        const orphanImages = imageFiles.filter(img => !matchedThumbnames.includes(img));

        orphanImages.forEach((imgFile) => {
            const baseName = path.parse(imgFile).name;
            const category = metadata[imgFile] || metadata[baseName] || 'illustration';

            presets.push({
                id: idCounter++,
                NAME: imgFile,
                THUMBNAIL: imgFile,
                CATEGORY: category
            });
        });

        res.json(presets);
    } catch (error) {
        console.error('프리셋 조회 에러:', error);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

/* ───────────── 파일 업로드 (+ GitHub 자동 커밋) ───────────── */
app.post('/api/upload', upload.fields([
    { name: 'effectFile', maxCount: 1 },
    { name: 'thumbFile', maxCount: 1 }
]), async (req, res) => {
    try {
        const category = req.body.category || 'motion';
        const metadata = loadMetadata();
        const toSync = [];

        ['effectFile', 'thumbFile'].forEach((field) => {
            if (req.files && req.files[field]) {
                const savedName = req.files[field][0].filename;
                metadata[savedName] = category;
                metadata[path.parse(savedName).name] = category;
                toSync.push(savedName);
            }
        });

        saveMetadata(metadata);

        let github = 'disabled';
        if (ghEnabled()) {
            try {
                await ghEnqueue(async () => {
                    for (const name of toSync) {
                        await ghPutFile(
                            `uploads/${name}`,
                            fs.readFileSync(path.join(uploadsDir, name)),
                            `Add ${name}`
                        );
                    }
                    await ghPutFile('metadata.json', fs.readFileSync(metaFile), 'Update metadata');
                });
                github = 'synced';
            } catch (e) {
                console.error('GitHub 동기화 실패:', e);
                github = 'failed';
            }
        }

        res.json({ success: true, message: '성공적으로 업로드되었습니다.', category, github });
    } catch (error) {
        console.error('업로드 처리 에러:', error);
        res.status(500).json({ error: '파일 업로드 실패' });
    }
});

/* ───────────── 파일 삭제 (+ GitHub 삭제) ───────────── */
app.delete('/api/delete/:filename', async (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const baseName = path.parse(filename).name;
        const deleted = [];

        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deleted.push(filename);
        }

        fs.readdirSync(uploadsDir).forEach(file => {
            if (path.parse(file).name === baseName && file.match(IMAGE_REGEX)) {
                fs.unlinkSync(path.join(uploadsDir, file));
                deleted.push(file);
            }
        });

        const metadata = loadMetadata();
        delete metadata[filename];
        delete metadata[baseName];
        saveMetadata(metadata);

        let github = 'disabled';
        if (ghEnabled()) {
            try {
                await ghEnqueue(async () => {
                    for (const name of deleted) {
                        await ghDeleteFile(`uploads/${name}`, `Delete ${name}`);
                    }
                    await ghPutFile('metadata.json', fs.readFileSync(metaFile), 'Update metadata');
                });
                github = 'synced';
            } catch (e) {
                console.error('GitHub 삭제 동기화 실패:', e);
                github = 'failed';
            }
        }

        res.json({ success: true, message: '파일이 성공적으로 삭제되었습니다.', github });
    } catch (error) {
        console.error('파일 삭제 에러:', error);
        res.status(500).json({ error: '파일 삭제 실패' });
    }
});

/* ───────────── 백업 ZIP 다운로드 ───────────── */
app.get('/api/download-sync-zip', (req, res) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('github-uploads-sync.zip');

    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });

    archive.pipe(res);
    archive.directory(uploadsDir, 'uploads');
    if (fs.existsSync(metaFile)) {
        archive.file(metaFile, { name: 'metadata.json' });
    }
    archive.finalize();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'index.html'));
});

restoreFromGitHub()
    .catch(e => console.error('GitHub 복원 실패:', e))
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
            console.log(ghEnabled() ? '🔗 GitHub 자동 동기화: 켜짐' : '⚠️ GitHub 자동 동기화: 꺼짐 (환경변수 미설정)');
        });
    });