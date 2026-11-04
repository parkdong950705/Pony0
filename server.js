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
const GITHUB_REPO = process.env.GITHUB_REPO; // 예: "parkdong950705/Pony0"
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
            try {
                syncFileToGihubWithRetry('metadata.json', fs.readFileSync(metaFile));
            } catch (err) {
                console.error('GitHub metadata 동기화 예외:', err);
            }
        }
    } catch (e) {
        console.error('메타데이터 저장 실패:', e);
    }
}

// 🌐 409 충돌 방지를 위한 순차 재시도 래퍼 함수
let syncQueue = Promise.resolve();
function syncFileToGihubWithRetry(fileName, fileBuffer) {
    syncQueue = syncQueue.then(() => {
        return new Promise((resolve) => {
            syncFileToGithub(fileName, fileBuffer, () => {
                setTimeout(resolve, 500);
            });
        });
    }).catch(() => {});
}

// 🌐 깃허브 API 통신 함수
function syncFileToGithub(fileName, fileBuffer, callback = () => {}) {
    if (!isGithubSyncEnabled) {
        callback();
        return;
    }

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
            executeGitHubPut(apiPath, fileName, fileBuffer, sha, callback);
        });
    });

    reqGet.on('error', (err) => {
        console.error('GitHub GET 통신 에러:', err);
        callback();
    });
    reqGet.end();
}

function executeGitHubPut(apiPath, fileName, fileBuffer, sha, callback) {
    try {
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
                callback();
            });
        });

        reqPut.on('error', (err) => {
            console.error('❌ GitHub PUT 통신 에러:', err);
            callback();
        });

        reqPut.write(dataString);
        reqPut.end();
    } catch (e) {
        console.error('executeGitHubPut 예외 발생:', e);
        callback();
    }
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
    reqGet.on('error', () => {});
    reqGet.end();
}

function executeGitHubDelete(apiPath, fileName, sha) {
    if (!sha) return;

    try {
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
        reqDel.on('error', () => {});
        reqDel.write(dataString);
        reqDel.end();
    } catch (e) {}
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

// 프리셋 목록 조회 API (metadata.json 노출 원천 차단)
app.get('/api/presets', (req, res) => {
    try {
        if (!fs.existsSync(uploadsDir)) {
            return res.json([]);
        }
        
        const files = fs.readdirSync(uploadsDir);
        // metadata.json 및 시스템 파일(.gitkeep 등)을 라이브러리 목록에서 철저히 제외
        const validFiles = files.filter(file => file !== 'metadata.json' && file !== '.gitkeep');
        
        const effectFiles = validFiles.filter(file => !file.match(/\.(jpg|jpeg|png|gif|webp)$/i));
        const imageFiles = validFiles.filter(file => file.match(/\.(jpg|jpeg|png|gif|webp)$/i));
        const metadata = loadMetadata();
        
        let presets = [];
        let idCounter = 1;
        let matchedImages = new Set();

        // 1. 효과 파일 처리 (지정 썸네일 또는 이름 일치 썸네일 매칭)
        effectFiles.forEach((file) => {
            const baseName = path.parse(file).name;
            let thumbFile = 'default-thumb.png';
            
            const linkedThumb = metadata[`thumb_${file}`] || metadata[`thumb_${baseName}`];
            
            if (linkedThumb && imageFiles.includes(linkedThumb)) {
                thumbFile = linkedThumb;
                matchedImages.add(linkedThumb);
            } else {
                const exactThumb = imageFiles.find(f => path.parse(f).name === baseName);
                if (exactThumb) {
                    thumbFile = exactThumb;
                    matchedImages.add(exactThumb);
                }
            }

            let category = metadata[file] || metadata[baseName] || 'motion';

            presets.push({
                id: idCounter++,
                NAME: file,
                THUMBNAIL: thumbFile,
                CATEGORY: category
            });
        });

        // 2. 단독 이미지 파일 처리 (효과 파일과 짝지어지지 않은 이미지만 '단순 일러스트' 카드로 독립 생성)
        imageFiles.forEach((imgFile) => {
            if (!matchedImages.has(imgFile)) {
                const baseName = path.parse(imgFile).name;
                let category = metadata[imgFile] || metadata[baseName] || 'illustration';

                presets.push({
                    id: idCounter++,
                    NAME: imgFile,
                    THUMBNAIL: imgFile,
                    CATEGORY: category
                });
            }
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
        const hasEffect = req.files && req.files['effectFile'];
        const hasThumb = req.files && req.files['thumbFile'];

        let category = req.body.category || 'motion';
        if (!hasEffect && hasThumb) {
            category = 'illustration';
        }

        const metadata = loadMetadata();
        let effName = null;
        let thumbName = null;

        if (hasEffect) {
            const fileObj = req.files['effectFile'][0];
            effName = Buffer.from(fileObj.originalname, 'latin1').toString('utf8');
            metadata[effName] = category;
            metadata[path.parse(effName).name] = category;

            try {
                const fileBuffer = fs.readFileSync(fileObj.path);
                syncFileToGihubWithRetry(effName, fileBuffer);
            } catch (err) {
                console.error('effectFile sync 예외:', err);
            }
        }

        if (hasThumb) {
            const fileObj = req.files['thumbFile'][0];
            thumbName = Buffer.from(fileObj.originalname, 'latin1').toString('utf8');
            metadata[thumbName] = category;
            metadata[path.parse(thumbName).name] = category;

            try {
                const fileBuffer = fs.readFileSync(fileObj.path);
                syncFileToGihubWithRetry(thumbName, fileBuffer);
            } catch (err) {
                console.error('thumbFile sync 예외:', err);
            }
        }

        if (effName && thumbName) {
            metadata[`thumb_${effName}`] = thumbName;
            metadata[`thumb_${path.parse(effName).name}`] = thumbName;
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

        const metadata = loadMetadata();
        let targetToDelete = [filename];

        const linkedThumb = metadata[`thumb_${filename}`] || metadata[`thumb_${baseName}`];
        if (linkedThumb) {
            targetToDelete.push(linkedThumb);
        }

        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            if (path.parse(file).name === baseName && file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                if (!targetToDelete.includes(file)) {
                    targetToDelete.push(file);
                }
            }
        });

        targetToDelete.forEach(targetFile => {
            const targetPath = path.join(uploadsDir, targetFile);
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                deleteFileFromGithub(targetFile);
            }
            delete metadata[targetFile];
        });

        delete metadata[filename];
        delete metadata[baseName];
        delete metadata[`thumb_${filename}`];
        delete metadata[`thumb_${baseName}`];
        saveMetadata(metadata);

        res.json({ success: true, message: '파일과 연관 썸네일이 성공적으로 삭제되었습니다.' });
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