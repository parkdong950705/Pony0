const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const metaFile = path.join(__dirname, 'metadata.json');

// 🌐 깃허브 환경 변수 설정
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // 예: "아이디/저장소명"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const isGithubSyncEnabled = Boolean(GITHUB_TOKEN && GITHUB_REPO);
console.log(`📌 GitHub 자동 동기화: ${isGithubSyncEnabled ? '켜짐' : '꺼짐 (환경변수 미설정)'}`);

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
        if (isGithubSyncEnabled) {
            syncFileToGithub('metadata.json', fs.readFileSync(metaFile));
        }
    } catch (e) {
        console.error('메타데이터 저장 실패:', e);
    }
}

// 🌐 깃허브 API 통신 함수
function syncFileToGithub(fileName, fileBuffer) {
    if (!isGithubSyncEnabled) return;

    const apiPath = `/repos/${GITHUB_REPO}/contents/uploads/${fileName}`;
    
    const getOptions = {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: {
            'User-Agent': 'FFX-Cloud-Studio',
            'Authorization': `token ${GITHUB_TOKEN}`
        }
    };

    const reqGet = https.request(getOptions, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
            let sha = null;
            if (res.statusCode === 200) {
                try {
                    sha = JSON.parse(responseBody).sha;
                } catch (e) {}
            }
            executeGitHubPut(apiPath, fileName, fileBuffer, sha);
        });
    });

    reqGet.on('error', () => {
        executeGitHubPut(apiPath, fileName, fileBuffer, null);
    });
    reqGet.end();
}

function executeGitHubPut(apiPath, fileName, fileBuffer, sha) {
    const payload = {
        message: `Auto-sync: update uploads/${fileName}`,
        content: fileBuffer.toString('base64'),
        branch: GITHUB_BRANCH
    };
    if (sha) payload.sha = sha;

    const dataString = JSON.stringify(payload);
    const options = {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'PUT',
        headers: {
            'User-Agent': 'FFX-Cloud-Studio',
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dataString)
        }
    };

    const reqPut = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                console.log(`✅ GitHub 동기화 성공: uploads/${fileName}`);
            } else {
                console.error(`❌ GitHub 동기화 실패 (${res.statusCode}):`, body);
            }
        });
    });

    reqPut.on('error', (err) => {
        console.error('❌ GitHub 통신 에러:', err);
    });

    reqPut.write(dataString);
    reqPut.end();
}

// 🌐 깃허브 파일 삭제 연동 함수
function deleteFileFromGithub(fileName) {
    if (!isGithubSyncEnabled) return;

    const apiPath = `/repos/${GITHUB_REPO}/contents/uploads/${fileName}`;
    const getOptions = {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: {
            'User-Agent': 'FFX-Cloud-Studio',
            'Authorization': `token ${GITHUB_TOKEN}`
        }
    };

    const reqGet = https.request(getOptions, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                try {
                    const sha = JSON.parse(responseBody).sha;
                    executeGitHubDelete(apiPath, fileName, sha);
                } catch (e) {}
            }
        });
    });
    reqGet.end();
}

function executeGitHubDelete(apiPath, fileName, sha) {
    if (!sha) return;

    const payload = {
        message: `Auto-sync: delete uploads/${fileName}`,
        sha: sha,
        branch: GITHUB_BRANCH
    };

    const dataString = JSON.stringify(payload);
    const options = {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'DELETE',
        headers: {
            'User-Agent': 'FFX-Cloud-Studio',
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dataString)
        }
    };

    const reqDel = https.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`🗑️ GitHub 파일 삭제 동기화 성공: uploads/${fileName}`);
        }
    });
    reqDel.write(dataString);
    reqDel.end();
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, decodedName);
    }
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'ffx-panel')));

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'style.css'));
});

app.get('/main.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'main.js'));
});

// 프리셋 목록 조회 API
app.get('/api/presets', (req, res) => {
    try {
        if (!fs.existsSync(uploadsDir)) {
            return res.json([]);
        }
        
        const files = fs.readdirSync(uploadsDir);
        const effectFiles = files.filter(file => !file.match(/\.(jpg|jpeg|png|gif|webp)$/i));
        const imageFiles = files.filter(file => file.match(/\.(jpg|jpeg|png|gif|webp)$/i));
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

            let category = metadata[file] || metadata[baseName] || 'motion';

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
            let category = metadata[imgFile] || metadata[baseName] || 'illustration';

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

// 파일 업로드 처리 API
app.post('/api/upload', upload.fields([
    { name: 'effectFile', maxCount: 1 },
    { name: 'thumbFile', maxCount: 1 }
]), (req, res) => {
    try {
        const category = req.body.category || 'motion';
        const metadata = loadMetadata();

        if (req.files['effectFile']) {
            const fileObj = req.files['effectFile'][0];
            const effName = Buffer.from(fileObj.originalname, 'latin1').toString('utf8');
            metadata[effName] = category;
            metadata[path.parse(effName).name] = category;

            const fileBuffer = fs.readFileSync(fileObj.path);
            syncFileToGithub(effName, fileBuffer);
        }

        if (req.files['thumbFile']) {
            const fileObj = req.files['thumbFile'][0];
            const thumbName = Buffer.from(fileObj.originalname, 'latin1').toString('utf8');
            metadata[thumbName] = category;
            metadata[path.parse(thumbName).name] = category;

            const fileBuffer = fs.readFileSync(fileObj.path);
            syncFileToGithub(thumbName, fileBuffer);
        }

        saveMetadata(metadata);
        res.json({ success: true, message: '성공적으로 업로드되었습니다.', category });
    } catch (error) {
        console.error('업로드 처리 에러:', error);
        res.status(500).json({ error: '파일 업로드 실패' });
    }
});

// 파일 삭제 API
app.delete('/api/delete/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const baseName = path.parse(filename).name;
        const filePath = path.join(uploadsDir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deleteFileFromGithub(filename);
        }

        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            if (path.parse(file).name === baseName && file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                const thumbPath = path.join(uploadsDir, file);
                if (fs.existsSync(thumbPath)) {
                    fs.unlinkSync(thumbPath);
                    deleteFileFromGithub(file);
                }
            }
        });

        const metadata = loadMetadata();
        delete metadata[filename];
        delete metadata[baseName];
        saveMetadata(metadata);

        res.json({ success: true, message: '파일이 성공적으로 삭제되었습니다.' });
    } catch (error) {
        console.error('파일 삭제 에러:', error);
        res.status(500).json({ error: '파일 삭제 실패' });
    }
});

// 백업 ZIP 다운로드 API
app.get('/api/download-sync-zip', (req, res) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('github-uploads-sync.zip');

    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });

    archive.pipe(res);
    archive.directory(uploadsDir, false);
    if (fs.existsSync(metaFile)) {
        archive.file(metaFile, { name: 'metadata.json' });
    }
    archive.finalize();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ffx-panel', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});