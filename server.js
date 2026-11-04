
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

// GitHub 환경변수
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = (process.env.GITHUB_REPO || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '');

const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const isGithubSyncEnabled = Boolean(
    GITHUB_TOKEN && GITHUB_REPO
);

console.log(
    `📌 GitHub 자동 동기화: ${
        isGithubSyncEnabled ? '켜짐' : '꺼짐'
    }`
);

// 메타데이터 읽기
function loadMetadata() {
    try {
        if (fs.existsSync(metaFile)) {
            return JSON.parse(
                fs.readFileSync(metaFile, 'utf8')
            );
        }
    } catch (e) {
        console.error('메타데이터 로드 실패:', e);
    }

    return {};
}

// GitHub 순차 동기화 큐
let syncQueue = Promise.resolve();

// GitHub API 요청
function githubRequest(method, apiPath, payload = null) {
    return new Promise((resolve, reject) => {

        const dataString = payload
            ? JSON.stringify(payload)
            : null;

        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            method: method,
            headers: {
                'User-Agent': 'FFX-Cloud-Studio',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Authorization': `Bearer ${GITHUB_TOKEN}`,

                ...(dataString ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(dataString)
                } : {})
            }
        };

        const req = https.request(options, (res) => {

            let body = '';

            res.on('data', chunk => {
                body += chunk;
            });

            res.on('end', () => {

                let parsed = {};

                try {
                    parsed = body
                        ? JSON.parse(body)
                        : {};
                } catch (_) {}

                if (
                    res.statusCode >= 200 &&
                    res.statusCode < 300
                ) {
                    resolve({
                        statusCode: res.statusCode,
                        data: parsed
                    });

                } else {

                    const error = new Error(
                        `GitHub API ${method} 실패 (${res.statusCode}): ${body}`
                    );

                    error.statusCode = res.statusCode;

                    reject(error);
                }
            });
        });

        req.setTimeout(30000, () => {
            req.destroy(
                new Error('GitHub API 요청 시간 초과')
            );
        });

        req.on('error', reject);

        if (dataString) {
            req.write(dataString);
        }

        req.end();
    });
}

// GitHub 파일 업로드
async function syncFileToGithubOnce(fileName, fileBuffer) {

    if (fileBuffer.length > 100 * 1024 * 1024) {
        throw new Error(
            `파일이 100MB를 초과합니다. (${(
                fileBuffer.length / 1024 / 1024
            ).toFixed(1)}MB)`
        );
    }

    console.log(
        `📤 GitHub 전송 시작: uploads/${fileName} (${fileBuffer.length} bytes)`
    );

    const encodedName = encodeURIComponent(fileName);

    const apiPath =
        `/repos/${GITHUB_REPO}/contents/uploads/${encodedName}`;

    let sha = null;

    // 기존 파일 확인
    try {

        const current = await githubRequest(
            'GET',
            apiPath
        );

        sha = current.data.sha || null;

    } catch (error) {

        if (error.statusCode !== 404) {
            throw error;
        }
    }

    // GitHub 업로드 데이터
    const payload = {
        message: `Auto-sync: ${
            sha ? 'update' : 'add'
        } uploads/${fileName}`,

        content: fileBuffer.toString('base64'),

        branch: GITHUB_BRANCH
    };

    if (sha) {
        payload.sha = sha;
    }

    await githubRequest(
        'PUT',
        apiPath,
        payload
    );

    console.log(
        `✅ GitHub 동기화 성공: uploads/${fileName}`
    );
}

// GitHub 재시도 + 순차 처리
function syncFileToGihubWithRetry(fileName, fileBuffer) {

    if (!isGithubSyncEnabled) {
        return Promise.resolve();
    }

    const task = syncQueue.then(async () => {

        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {

            try {

                await syncFileToGithubOnce(
                    fileName,
                    fileBuffer
                );

                return;

            } catch (error) {

                lastError = error;

                console.error(
                    `❌ GitHub 동기화 실패 (${attempt}/3) uploads/${fileName}:`,
                    error.message
                );

                if (attempt < 3) {
                    await new Promise(resolve => {
                        setTimeout(resolve, attempt * 1500);
                    });
                }
            }
        }

        throw lastError;
    });

    // 실패하더라도 다음 작업 진행
    syncQueue = task.catch(() => {});

    return task;
}

// 메타데이터 저장
function saveMetadata(data) {

    fs.writeFileSync(
        metaFile,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    return data;
}

// GitHub 파일 삭제
function deleteFileFromGithub(fileName) {

    if (!isGithubSyncEnabled) return;

    const apiPath =
        `/repos/${GITHUB_REPO}/contents/uploads/${encodeURIComponent(fileName)}`;

    const getOptions = {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: {
            'User-Agent': 'FFX-Cloud-Studio',
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json'
        }
    };

    const reqGet = https.request(getOptions, (res) => {

        let responseBody = '';

        res.on('data', chunk => {
            responseBody += chunk;
        });

        res.on('end', () => {

            if (res.statusCode === 200) {

                try {

                    const sha = JSON.parse(responseBody).sha;

                    executeGitHubDelete(
                        apiPath,
                        fileName,
                        sha
                    );

                } catch (e) {
                    console.error('GitHub 삭제 SHA 확인 실패:', e);
                }
            }
        });
    });

    reqGet.on('error', err => {
        console.error('GitHub 삭제 요청 실패:', err.message);
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
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dataString)
        }
    };

    const reqDel = https.request(options, (res) => {

        let body = '';

        res.on('data', chunk => {
            body += chunk;
        });

        res.on('end', () => {

            if (
                res.statusCode >= 200 &&
                res.statusCode < 300
            ) {
                console.log(
                    `🗑️ GitHub 파일 삭제 성공: uploads/${fileName}`
                );
            } else {
                console.error(
                    'GitHub 삭제 실패:',
                    res.statusCode,
                    body
                );
            }
        });
    });

    reqDel.on('error', err => {
        console.error('GitHub 삭제 통신 오류:', err.message);
    });

    reqDel.write(dataString);
    reqDel.end();
}

// Multer 업로드 설정
const storage = multer.diskStorage({

    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },

    filename: (req, file, cb) => {

        const decodedName = Buffer
            .from(file.originalname, 'latin1')
            .toString('utf8');

        cb(null, path.basename(decodedName));
    }
});

const upload = multer({

    storage: storage,

    limits: {
        fileSize: 100 * 1024 * 1024,
        files: 2
    }
});

// 정적 파일
app.use('/uploads', express.static(uploadsDir));

app.use(
    express.static(path.join(__dirname, 'ffx-panel'))
);

app.get('/style.css', (req, res) => {
    res.sendFile(
        path.join(__dirname, 'ffx-panel', 'style.css')
    );
});

app.get('/main.js', (req, res) => {
    res.sendFile(
        path.join(__dirname, 'ffx-panel', 'main.js')
    );
});

// GitHub 설정 진단
app.get('/api/github-status', async (req, res) => {

    if (!isGithubSyncEnabled) {

        return res.status(503).json({
            enabled: false,
            message: 'GITHUB_TOKEN 또는 GITHUB_REPO가 설정되지 않았습니다.'
        });
    }

    try {

        const result = await githubRequest(
            'GET',
            `/repos/${GITHUB_REPO}`
        );

        res.json({

            enabled: true,

            authenticated: true,

            repository: result.data.full_name,

            defaultBranch: result.data.default_branch,

            configuredBranch: GITHUB_BRANCH,

            message: 'GitHub 인증 및 저장소 접근이 정상입니다.'
        });

    } catch (error) {

        console.error(
            'GitHub 상태 확인 실패:',
            error.message
        );

        res.status(502).json({

            enabled: true,

            authenticated: false,

            repository: GITHUB_REPO,

            configuredBranch: GITHUB_BRANCH,

            statusCode: error.statusCode || null,

            error: error.message
        });
    }
});

// 프리셋 목록 조회
app.get('/api/presets', (req, res) => {

    try {

        if (!fs.existsSync(uploadsDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(uploadsDir);

        const validFiles = files.filter(file =>
            file !== 'metadata.json' &&
            file !== '.gitkeep'
        );

        const effectFiles = validFiles.filter(file =>
            !file.match(/\.(jpg|jpeg|png|gif|webp)$/i)
        );

        const imageFiles = validFiles.filter(file =>
            file.match(/\.(jpg|jpeg|png|gif|webp)$/i)
        );

        const metadata = loadMetadata();

        let presets = [];
        let idCounter = 1;
        let matchedImages = new Set();

        effectFiles.forEach(file => {

            const baseName = path.parse(file).name;

            let thumbFile = 'default-thumb.png';

            const linkedThumb =
                metadata[`thumb_${file}`] ||
                metadata[`thumb_${baseName}`];

            if (
                linkedThumb &&
                imageFiles.includes(linkedThumb)
            ) {

                thumbFile = linkedThumb;
                matchedImages.add(linkedThumb);

            } else {

                const exactThumb = imageFiles.find(
                    f => path.parse(f).name === baseName
                );

                if (exactThumb) {

                    thumbFile = exactThumb;
                    matchedImages.add(exactThumb);
                }
            }

            const category =
                metadata[file] ||
                metadata[baseName] ||
                'motion';

            presets.push({

                id: idCounter++,

                NAME: file,

                THUMBNAIL: thumbFile,

                CATEGORY: category
            });
        });

        imageFiles.forEach(imgFile => {

            if (!matchedImages.has(imgFile)) {

                const baseName = path.parse(imgFile).name;

                const category =
                    metadata[imgFile] ||
                    metadata[baseName] ||
                    'illustration';

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

        console.error(
            '프리셋 조회 에러:',
            error
        );

        res.status(500).json({
            error: '서버 내부 오류가 발생했습니다.'
        });
    }
});

// 파일 업로드 API
app.post(
    '/api/upload',

    upload.fields([
        { name: 'effectFile', maxCount: 1 },
        { name: 'thumbFile', maxCount: 1 }
    ]),

    async (req, res) => {

        const receivedFiles = req.files || {};

        const effect =
            receivedFiles.effectFile?.[0] || null;

        const thumb =
            receivedFiles.thumbFile?.[0] || null;

        console.log('📥 업로드 요청 수신:', {

            fields: Object.keys(receivedFiles),

            effect: effect ? {
                name: effect.originalname,
                storedAs: effect.filename,
                size: effect.size
            } : null,

            thumb: thumb ? {
                name: thumb.originalname,
                storedAs: thumb.filename,
                size: thumb.size
            } : null,

            githubEnabled: isGithubSyncEnabled,

            repo: GITHUB_REPO || '(not set)',

            branch: GITHUB_BRANCH
        });

        if (!effect && !thumb) {

            return res.status(400).json({

                success: false,

                error: '서버가 업로드 파일을 받지 못했습니다. 파일 필드명을 확인해주세요.',

                receivedFields: Object.keys(receivedFiles)
            });
        }

        try {

            let category = req.body.category || 'motion';

            if (!effect && thumb) {
                category = 'illustration';
            }

            const metadata = loadMetadata();

            const filesToSync = [];

            // 효과 파일
            if (effect) {

                const fileName = path.basename(effect.filename);

                metadata[fileName] = category;

                metadata[path.parse(fileName).name] = category;

                filesToSync.push({

                    name: fileName,

                    path: effect.path
                });
            }

            // 썸네일 이미지
            if (thumb) {

                const fileName = path.basename(thumb.filename);

                metadata[fileName] = category;

                metadata[path.parse(fileName).name] = category;

                filesToSync.push({

                    name: fileName,

                    path: thumb.path
                });
            }

            // 썸네일 연결 정보
            if (effect && thumb) {

                const effectName = path.basename(effect.filename);

                const thumbName = path.basename(thumb.filename);

                metadata[`thumb_${effectName}`] = thumbName;

                metadata[`thumb_${path.parse(effectName).name}`] = thumbName;
            }

            const syncFailures = [];

            const syncSuccesses = [];

            // GitHub 파일 개별 동기화
            if (isGithubSyncEnabled) {

                for (const item of filesToSync) {

                    try {

                        const buffer = fs.readFileSync(item.path);

                        await syncFileToGihubWithRetry(
                            item.name,
                            buffer
                        );

                        syncSuccesses.push(item.name);

                    } catch (error) {

                        console.error(
                            `🚨 파일 GitHub 동기화 최종 실패: ${item.name}`,
                            error.message
                        );

                        syncFailures.push({

                            file: item.name,

                            error: error.message,

                            statusCode: error.statusCode || null
                        });
                    }
                }
            }

            // 메타데이터 저장
            saveMetadata(metadata);

            // 메타데이터도 GitHub에 전송
            if (isGithubSyncEnabled) {

                try {

                    await syncFileToGihubWithRetry(
                        'metadata.json',
                        fs.readFileSync(metaFile)
                    );

                } catch (error) {

                    console.error(
                        '🚨 metadata.json GitHub 동기화 실패:',
                        error.message
                    );

                    syncFailures.push({

                        file: 'metadata.json',

                        error: error.message,

                        statusCode: error.statusCode || null
                    });
                }
            }

            // 동기화 실패 응답
            if (syncFailures.length > 0) {

                return res.status(502).json({

                    success: false,

                    message: '서버에는 파일이 저장되었지만 GitHub 동기화에 실패했습니다.',

                    github: 'failed',

                    syncedFiles: syncSuccesses,

                    failures: syncFailures
                });
            }

            // 성공 응답
            res.json({

                success: true,

                message: '성공적으로 업로드되었습니다.',

                github: isGithubSyncEnabled
                    ? 'synced'
                    : 'disabled',

                syncedFiles: syncSuccesses,

                category
            });

        } catch (error) {

            console.error(
                '업로드 처리 에러:',
                error
            );

            res.status(500).json({

                success: false,

                error: '파일 업로드 처리 실패',

                detail: error.message
            });
        }
    }
);

// 파일 삭제 API
app.delete('/api/delete/:filename', (req, res) => {

    try {

        const filename = path.basename(
            decodeURIComponent(req.params.filename)
        );

        const baseName = path.parse(filename).name;

        const metadata = loadMetadata();

        let targetToDelete = [filename];

        const linkedThumb =
            metadata[`thumb_${filename}`] ||
            metadata[`thumb_${baseName}`];

        if (linkedThumb) {
            targetToDelete.push(linkedThumb);
        }

        const files = fs.readdirSync(uploadsDir);

        files.forEach(file => {

            if (
                path.parse(file).name === baseName &&
                file.match(/\.(jpg|jpeg|png|gif|webp)$/i)
            ) {

                if (!targetToDelete.includes(file)) {
                    targetToDelete.push(file);
                }
            }
        });

        targetToDelete.forEach(targetFile => {

            const targetPath = path.join(
                uploadsDir,
                targetFile
            );

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

        res.json({

            success: true,

            message: '파일과 연관 썸네일이 성공적으로 삭제되었습니다.'
        });

    } catch (error) {

        console.error(
            '파일 삭제 에러:',
            error
        );

        res.status(500).json({

            error: '파일 삭제 실패'
        });
    }
});

// GitHub ZIP 백업
app.get('/api/download-sync-zip', (req, res) => {

    try {

        if (!fs.existsSync(uploadsDir)) {

            return res.status(404).json({
                error: '백업할 파일이 없습니다.'
            });
        }

        res.setHeader(
            'Content-Type',
            'application/zip'
        );

        res.setHeader(
            'Content-Disposition',
            'attachment; filename="FFX-Cloud-Backup.zip"'
        );

        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        archive.on('error', error => {

            console.error('ZIP 압축 오류:', error);

            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.destroy(error);
            }
        });

        archive.pipe(res);

        archive.directory(
            uploadsDir,
            'uploads'
        );

        archive.finalize();

    } catch (error) {

        console.error('ZIP 백업 오류:', error);

        res.status(500).json({
            error: '백업 파일 생성 실패'
        });
    }
});

// 서버 실행
app.listen(PORT, () => {

    console.log(
        `🚀 FFX Cloud Studio 서버 실행 중: 포트 ${PORT}`
    );
});
