
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

// 기본 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
const metaFile = path.join(__dirname, 'metadata.json');
const MAX_FILE_SIZE = 70 * 1024 * 1024;

fs.mkdirSync(uploadsDir, { recursive: true });

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

if (isGithubSyncEnabled && !/^[^/]+\/[^/]+$/.test(GITHUB_REPO)) {
    throw new Error('GITHUB_REPO는 owner/repository 형식이어야 합니다.');
}

console.log(
    `📌 GitHub 자동 동기화: ${
        isGithubSyncEnabled ? '켜짐' : '꺼짐 (환경변수 확인 필요)'
    }`
);

// --------------------------------------------------
// 파일명 및 메타데이터 관리
// --------------------------------------------------

function decodeOriginalFilename(originalname) {
    const raw = String(originalname || 'uploaded-file');

    const decoded = /[^\u0000-\u00FF]/.test(raw)
        ? raw
        : Buffer.from(raw, 'latin1').toString('utf8');

    return path.basename(decoded).replace(/[\u0000-\u001F]/g, '_');
}

function loadMetadata() {
    try {
        if (!fs.existsSync(metaFile)) return {};

        const parsed = JSON.parse(
            fs.readFileSync(metaFile, 'utf8')
        );

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('metadata.json 형식이 올바르지 않습니다.');
        }

        return parsed;

    } catch (error) {
        console.error('메타데이터 로드 실패:', error.message);
        return {};
    }
}

function saveMetadata(data) {
    const tempFile = `${metaFile}.tmp`;

    fs.writeFileSync(
        tempFile,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    fs.renameSync(tempFile, metaFile);
}

function ensureAssetGroups(metadata) {
    if (
        !metadata.assetGroups ||
        typeof metadata.assetGroups !== 'object' ||
        Array.isArray(metadata.assetGroups)
    ) {
        metadata.assetGroups = {};
    }

    return metadata.assetGroups;
}

function encodeRepoPath(filePath) {
    return filePath
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
}

// --------------------------------------------------
// GitHub API 통신
// --------------------------------------------------

let githubQueue = Promise.resolve();

function enqueueGithubTask(taskFunction) {
    const task = githubQueue.then(taskFunction);

    githubQueue = task.catch(() => {});

    return task;
}

function githubRequest(method, apiPath, payload = null) {
    return new Promise((resolve, reject) => {

        const body = payload === null
            ? null
            : JSON.stringify(payload);

        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            method,

            headers: {
                'User-Agent': 'FFX-Cloud-Studio',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Authorization': `Bearer ${GITHUB_TOKEN}`,

                ...(body ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                } : {})
            }
        };

        const request = https.request(options, response => {

            let responseBody = '';

            response.on('data', chunk => {
                responseBody += chunk;
            });

            response.on('end', () => {

                let parsed = {};

                try {
                    parsed = responseBody
                        ? JSON.parse(responseBody)
                        : {};
                } catch (_) {}

                if (
                    response.statusCode >= 200 &&
                    response.statusCode < 300
                ) {
                    resolve({
                        statusCode: response.statusCode,
                        data: parsed,
                        body: responseBody
                    });

                } else {

                    const error = new Error(
                        `GitHub API ${method} 실패 (${response.statusCode}): ${responseBody.slice(0, 1500)}`
                    );

                    error.statusCode = response.statusCode;

                    reject(error);
                }
            });
        });

        request.setTimeout(120000, () => {
            request.destroy(
                new Error('GitHub API 요청 시간 초과')
            );
        });

        request.on('error', reject);

        if (body) request.write(body);

        request.end();
    });
}

// GitHub 원본 파일 다운로드
function githubRequestRaw(apiPath) {
    return new Promise((resolve, reject) => {

        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            method: 'GET',

            headers: {
                'User-Agent': 'FFX-Cloud-Studio',
                'Accept': 'application/vnd.github.raw+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Authorization': `Bearer ${GITHUB_TOKEN}`
            }
        };

        const request = https.request(options, response => {

            const chunks = [];

            response.on('data', chunk => {
                chunks.push(Buffer.from(chunk));
            });

            response.on('end', () => {

                const buffer = Buffer.concat(chunks);

                if (
                    response.statusCode >= 200 &&
                    response.statusCode < 300
                ) {
                    resolve(buffer);

                } else {

                    const error = new Error(
                        `GitHub 파일 복원 실패 (${response.statusCode}): ${buffer.toString('utf8').slice(0, 1000)}`
                    );

                    error.statusCode = response.statusCode;

                    reject(error);
                }
            });
        });

        request.setTimeout(120000, () => {
            request.destroy(
                new Error('GitHub 파일 다운로드 시간 초과')
            );
        });

        request.on('error', reject);

        request.end();
    });
}

// --------------------------------------------------
// GitHub 파일 업로드
// --------------------------------------------------

async function syncFileToGithubOnce(fileName, fileBuffer) {

    if (fileBuffer.length > MAX_FILE_SIZE) {

        throw new Error(
            `파일이 70MB 제한을 초과했습니다: ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB`
        );
    }

    const safeName = path.basename(fileName);

    const apiPath =
        `/repos/${GITHUB_REPO}/contents/uploads/${encodeURIComponent(safeName)}`;

    let sha = null;

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

    const payload = {

        message: `FFX Cloud Studio: ${
            sha ? 'update' : 'add'
        } uploads/${safeName}`,

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
        `✅ GitHub 동기화 성공: uploads/${safeName}`
    );
}

function syncFileToGithub(fileName, fileBuffer) {

    if (!isGithubSyncEnabled) {
        return Promise.resolve({ skipped: true });
    }

    return enqueueGithubTask(async () => {

        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {

            try {

                console.log(
                    `📤 GitHub 전송 시작 (${attempt}/3): uploads/${fileName}`
                );

                await syncFileToGithubOnce(
                    fileName,
                    fileBuffer
                );

                return { success: true };

            } catch (error) {

                lastError = error;

                console.error(
                    `❌ GitHub 동기화 실패 (${attempt}/3): uploads/${fileName}`,
                    error.message
                );

                if (attempt < 3) {
                    await new Promise(resolve => {
                        setTimeout(resolve, attempt * 2000);
                    });
                }
            }
        }

        throw lastError;
    });
}

// --------------------------------------------------
// GitHub 파일 삭제
// --------------------------------------------------

async function deleteGithubFileOnce(fileName) {

    const safeName = path.basename(fileName);

    const apiPath =
        `/repos/${GITHUB_REPO}/contents/uploads/${encodeURIComponent(safeName)}`;

    let sha;

    try {

        const current = await githubRequest(
            'GET',
            apiPath
        );

        sha = current.data.sha;

    } catch (error) {

        if (error.statusCode === 404) return;

        throw error;
    }

    await githubRequest(
        'DELETE',
        apiPath,
        {
            message: `FFX Cloud Studio: delete uploads/${safeName}`,
            sha,
            branch: GITHUB_BRANCH
        }
    );

    console.log(
        `🗑️ GitHub 파일 삭제 성공: uploads/${safeName}`
    );
}

function deleteGithubFile(fileName) {

    if (!isGithubSyncEnabled) {
        return Promise.resolve();
    }

    return enqueueGithubTask(async () => {

        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {

            try {

                await deleteGithubFileOnce(fileName);

                return;

            } catch (error) {

                lastError = error;

                console.error(
                    `❌ GitHub 삭제 실패 (${attempt}/3): ${fileName}`,
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
}

// 메타데이터 동기화
async function syncMetadataToGithub(metadata) {

    saveMetadata(metadata);

    if (!isGithubSyncEnabled) return;

    await syncFileToGithub(
        'metadata.json',
        fs.readFileSync(metaFile)
    );
}

// --------------------------------------------------
// Render 재시작 시 GitHub에서 파일 및 설정 복원
// --------------------------------------------------

async function restoreUploadsFromGithub() {

    if (!isGithubSyncEnabled) {

        console.log(
            '⚠️ GitHub 복원 생략: GITHUB_TOKEN 또는 GITHUB_REPO가 없습니다.'
        );

        return;
    }

    console.log(
        `🔄 GitHub 복원 시작: ${GITHUB_REPO}/${GITHUB_BRANCH}`
    );

    const treePath =
        `/repos/${GITHUB_REPO}/git/trees/${encodeURIComponent(GITHUB_BRANCH)}?recursive=1`;

    const treeResult = await githubRequest(
        'GET',
        treePath
    );

    if (treeResult.data.truncated) {

        throw new Error(
            'GitHub 저장소 파일 목록이 너무 커서 전체 복원 목록이 잘렸습니다.'
        );
    }

    const remoteFiles = (
        treeResult.data.tree || []
    ).filter(item =>
        item.type === 'blob' &&
        item.path.startsWith('uploads/')
    );

    const metadataEntry = remoteFiles.find(
        item => item.path === 'uploads/metadata.json'
    );

    const assetEntries = remoteFiles.filter(
        item => item.path !== 'uploads/metadata.json'
    );

    let restoredCount = 0;

    // 모든 에셋 파일 복원
    for (const item of assetEntries) {

        const relativePath =
            item.path.slice('uploads/'.length);

        const destination = path.resolve(
            uploadsDir,
            relativePath
        );

        const allowedRoot =
            path.resolve(uploadsDir) + path.sep;

        if (!destination.startsWith(allowedRoot)) {

            throw new Error(
                `허용되지 않은 복원 경로: ${item.path}`
            );
        }

        const rawPath =
            `/repos/${GITHUB_REPO}/contents/${encodeRepoPath(item.path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

        const fileBuffer = await githubRequestRaw(rawPath);

        fs.mkdirSync(
            path.dirname(destination),
            { recursive: true }
        );

        const tempDestination =
            `${destination}.restore-tmp`;

        fs.writeFileSync(
            tempDestination,
            fileBuffer
        );

        fs.renameSync(
            tempDestination,
            destination
        );

        restoredCount++;

        console.log(
            `📥 복원 완료: ${item.path}`
        );
    }

    // 기존 메타데이터 복원
    if (metadataEntry) {

        const metadataPath =
            `/repos/${GITHUB_REPO}/contents/uploads/metadata.json?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

        const metadataBuffer = await githubRequestRaw(
            metadataPath
        );

        let githubMetadata;

        try {

            githubMetadata = JSON.parse(
                metadataBuffer.toString('utf8')
            );

        } catch (error) {

            throw new Error(
                `GitHub metadata.json 해석 실패: ${error.message}`
            );
        }

        if (
            !githubMetadata ||
            typeof githubMetadata !== 'object' ||
            Array.isArray(githubMetadata)
        ) {

            throw new Error(
                'GitHub metadata.json 형식이 올바르지 않습니다.'
            );
        }

        // GitHub 설정을 우선 적용하되 로컬에만 남은 기존 설정도 보존
        const localMetadata = loadMetadata();

        const mergedMetadata = {
            ...localMetadata,
            ...githubMetadata
        };

        const localGroups =
            localMetadata.assetGroups &&
            typeof localMetadata.assetGroups === 'object'
                ? localMetadata.assetGroups
                : {};

        const githubGroups =
            githubMetadata.assetGroups &&
            typeof githubMetadata.assetGroups === 'object'
                ? githubMetadata.assetGroups
                : {};

        if (
            Object.keys(localGroups).length ||
            Object.keys(githubGroups).length
        ) {

            mergedMetadata.assetGroups = {
                ...localGroups,
                ...githubGroups
            };
        }

        const tempMetaFile =
            `${metaFile}.restore-tmp`;

        fs.writeFileSync(
            tempMetaFile,
            JSON.stringify(mergedMetadata, null, 2),
            'utf8'
        );

        fs.renameSync(
            tempMetaFile,
            metaFile
        );

        console.log(
            '🧩 GitHub 및 기존 로컬 썸네일 연결·카테고리·에셋 그룹 설정 복원 완료'
        );

    } else {

        console.warn(
            '⚠️ GitHub uploads/metadata.json이 없습니다. 기존 로컬 metadata.json은 유지합니다.'
        );
    }

    console.log(
        `✅ GitHub 복원 완료: 에셋 파일 ${restoredCount}개`
    );
}

// --------------------------------------------------
// 파일 업로드 설정
// --------------------------------------------------

const storage = multer.diskStorage({

    destination: (req, file, callback) => {
        callback(null, uploadsDir);
    },

    filename: (req, file, callback) => {
        callback(
            null,
            decodeOriginalFilename(file.originalname)
        );
    }
});

const upload = multer({

    storage,

    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 2
    }
});

// 정적 파일 제공
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

// --------------------------------------------------
// GitHub 연결 상태 확인
// --------------------------------------------------

app.get('/api/github-status', async (req, res) => {

    if (!isGithubSyncEnabled) {

        return res.status(503).json({

            enabled: false,

            authenticated: false,

            message: 'Render 환경변수 GITHUB_TOKEN과 GITHUB_REPO를 확인해주세요.'
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

            message: 'GitHub 연결이 정상입니다.'
        });

    } catch (error) {

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

// --------------------------------------------------
// 프리셋 목록 조회
// --------------------------------------------------

app.get('/api/presets', (req, res) => {

    try {

        const files = fs.readdirSync(uploadsDir).filter(file =>
            file !== 'metadata.json' &&
            file !== '.gitkeep' &&
            !file.endsWith('.restore-tmp')
        );

        const imagePattern =
            /\.(jpg|jpeg|png|gif|webp)$/i;

        const effectFiles = files.filter(
            file => !imagePattern.test(file)
        );

        const imageFiles = files.filter(
            file => imagePattern.test(file)
        );

        const metadata = loadMetadata();

        const assetGroups =
            metadata.assetGroups &&
            typeof metadata.assetGroups === 'object'
                ? metadata.assetGroups
                : {};

        // 그룹 정보에서 효과 파일별 썸네일 찾기
        const groupThumbByEffect = {};

        for (const group of Object.values(assetGroups)) {

            if (
                group &&
                group.effectFile &&
                group.thumbnailFile
            ) {

                groupThumbByEffect[group.effectFile] =
                    group.thumbnailFile;
            }
        }

        const presets = [];

        const matchedImages = new Set();

        let idCounter = 1;

        for (const file of effectFiles) {

            const baseName = path.parse(file).name;

            const linkedThumb =
                metadata[`thumb_${file}`] ||
                metadata[`thumb_${baseName}`] ||
                groupThumbByEffect[file];

            let thumbFile = 'default-thumb.png';

            if (
                linkedThumb &&
                imageFiles.includes(linkedThumb)
            ) {

                thumbFile = linkedThumb;

                matchedImages.add(linkedThumb);

            } else {

                const exactThumb = imageFiles.find(
                    image => path.parse(image).name === baseName
                );

                if (exactThumb) {

                    thumbFile = exactThumb;

                    matchedImages.add(exactThumb);
                }
            }

            presets.push({

                id: idCounter++,

                NAME: file,

                THUMBNAIL: thumbFile,

                CATEGORY:
                    metadata[file] ||
                    metadata[baseName] ||
                    'motion'
            });
        }

        // 효과 파일에 연결되지 않은 이미지 표시
        for (const imageFile of imageFiles) {

            if (matchedImages.has(imageFile)) continue;

            const baseName =
                path.parse(imageFile).name;

            presets.push({

                id: idCounter++,

                NAME: imageFile,

                THUMBNAIL: imageFile,

                CATEGORY:
                    metadata[imageFile] ||
                    metadata[baseName] ||
                    'illustration'
            });
        }

        res.json(presets);

    } catch (error) {

        console.error(
            '프리셋 조회 에러:',
            error
        );

        res.status(500).json({
            error: '프리셋 목록을 불러오지 못했습니다.'
        });
    }
});

// --------------------------------------------------
// 파일 업로드
// --------------------------------------------------

app.post('/api/upload', (req, res, next) => {

    upload.fields([
        { name: 'effectFile', maxCount: 1 },
        { name: 'thumbFile', maxCount: 1 }
    ])(req, res, error => {

        if (error) {

            console.error(
                '파일 수신 실패:',
                error.message
            );

            const status =
                error instanceof multer.MulterError
                    ? 400
                    : 500;

            return res.status(status).json({

                success: false,

                error: error.message
            });
        }

        next();
    });

}, async (req, res) => {

    const effect =
        req.files?.effectFile?.[0] || null;

    const thumb =
        req.files?.thumbFile?.[0] || null;

    console.log('📥 업로드 요청 수신:', {

        effect: effect
            ? {
                name: effect.filename,
                size: effect.size
            }
            : null,

        thumb: thumb
            ? {
                name: thumb.filename,
                size: thumb.size
            }
            : null
    });

    if (!effect && !thumb) {

        return res.status(400).json({

            success: false,

            error: '효과 파일 또는 이미지 파일을 선택해주세요.'
        });
    }

    try {

        let category =
            req.body.category || 'motion';

        if (!effect && thumb) {
            category = 'illustration';
        }

        const metadata = loadMetadata();

        const groups = ensureAssetGroups(metadata);

        const effectName = effect
            ? path.basename(effect.filename)
            : null;

        const thumbName = thumb
            ? path.basename(thumb.filename)
            : null;

        // 동일한 업로드 요청을 하나의 그룹으로 저장
        const uploadedAt = new Date().toISOString();

        const groupId =
            `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        if (effectName) {

            metadata[effectName] = category;

            metadata[path.parse(effectName).name] =
                category;
        }

        if (thumbName) {

            metadata[thumbName] = category;

            metadata[path.parse(thumbName).name] =
                category;
        }

        // 기존 썸네일 연결 방식도 유지
        if (effectName && thumbName) {

            metadata[`thumb_${effectName}`] =
                thumbName;

            metadata[`thumb_${path.parse(effectName).name}`] =
                thumbName;
        }

        // 묶음 기록
        groups[groupId] = {

            uploadedAt,

            effectFile: effectName,

            thumbnailFile: thumbName,

            category
        };

        const filesToSync = [];

        if (effect) {

            filesToSync.push({

                name: effectName,

                path: effect.path
            });
        }

        if (thumb) {

            filesToSync.push({

                name: thumbName,

                path: thumb.path
            });
        }

        const syncedFiles = [];

        const failures = [];

        // 실제 파일을 GitHub로 전송
        if (isGithubSyncEnabled) {

            for (const item of filesToSync) {

                try {

                    const buffer =
                        fs.readFileSync(item.path);

                    await syncFileToGithub(
                        item.name,
                        buffer
                    );

                    syncedFiles.push(item.name);

                } catch (error) {

                    failures.push({

                        file: item.name,

                        error: error.message,

                        statusCode: error.statusCode || null
                    });
                }
            }
        }

        // 기존 로컬 메타데이터와 그룹 기록 저장
        saveMetadata(metadata);

        // 실제 파일이 모두 전송된 경우에만 GitHub에 연결 정보 저장
        if (
            isGithubSyncEnabled &&
            failures.length === 0
        ) {

            try {

                await syncFileToGithub(
                    'metadata.json',
                    fs.readFileSync(metaFile)
                );

            } catch (error) {

                failures.push({

                    file: 'metadata.json',

                    error: error.message,

                    statusCode: error.statusCode || null
                });
            }
        }

        if (failures.length > 0) {

            return res.status(502).json({

                success: false,

                github: 'failed',

                message: '서버에는 파일이 저장됐지만 GitHub 동기화에 실패했습니다.',

                syncedFiles,

                failures
            });
        }

        res.json({

            success: true,

            github: isGithubSyncEnabled
                ? 'synced'
                : 'disabled',

            message: '업로드 및 에셋 연결 저장이 완료되었습니다.',

            groupId,

            uploadedAt,

            syncedFiles,

            category
        });

    } catch (error) {

        console.error(
            '업로드 처리 오류:',
            error
        );

        res.status(500).json({

            success: false,

            error: '업로드 처리에 실패했습니다.',

            detail: error.message
        });
    }
});

// --------------------------------------------------
// 파일 삭제: 연결된 이미지와 그룹도 함께 삭제
// --------------------------------------------------

app.delete('/api/delete/:filename', async (req, res) => {

    try {

        const filename = path.basename(
            decodeURIComponent(req.params.filename)
        );

        const baseName =
            path.parse(filename).name;

        const metadata = loadMetadata();

        const groups = ensureAssetGroups(metadata);

        const targets = new Set([filename]);

        const linkedThumb =
            metadata[`thumb_${filename}`] ||
            metadata[`thumb_${baseName}`];

        if (linkedThumb) {
            targets.add(linkedThumb);
        }

        // 그룹 ID 기준으로 짝 파일 찾기
        for (const [groupId, group] of Object.entries(groups)) {

            if (
                group &&
                (
                    group.effectFile === filename ||
                    group.thumbnailFile === filename
                )
            ) {

                if (group.effectFile) {
                    targets.add(group.effectFile);
                }

                if (group.thumbnailFile) {
                    targets.add(group.thumbnailFile);
                }

                delete groups[groupId];
            }
        }

        // 이전 버전과 호환: 같은 이름의 이미지도 찾기
        for (const localFile of fs.readdirSync(uploadsDir)) {

            if (
                path.parse(localFile).name === baseName &&
                /\.(jpg|jpeg|png|gif|webp)$/i.test(localFile)
            ) {

                targets.add(localFile);
            }
        }

        // GitHub 삭제를 먼저 완료
        if (isGithubSyncEnabled) {

            for (const target of targets) {

                await deleteGithubFile(target);
            }
        }

        // 로컬 파일 삭제
        for (const target of targets) {

            const targetPath = path.join(
                uploadsDir,
                path.basename(target)
            );

            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }

            delete metadata[target];

            delete metadata[path.parse(target).name];
        }

        // 이전 썸네일 연결 기록도 삭제
        for (const key of Object.keys(metadata)) {

            if (
                key.startsWith('thumb_') &&
                targets.has(metadata[key])
            ) {

                delete metadata[key];
            }
        }

        saveMetadata(metadata);

        // GitHub 메타데이터 갱신
        if (isGithubSyncEnabled) {

            await syncFileToGithub(
                'metadata.json',
                fs.readFileSync(metaFile)
            );
        }

        res.json({

            success: true,

            deletedFiles: Array.from(targets),

            message: '파일과 연결된 썸네일 및 그룹 정보가 삭제되었습니다.'
        });

    } catch (error) {

        console.error(
            '파일 삭제 오류:',
            error
        );

        res.status(500).json({

            success: false,

            error: '파일 삭제에 실패했습니다.',

            detail: error.message
        });
    }
});

// --------------------------------------------------
// ZIP 백업
// --------------------------------------------------

app.get('/api/download-sync-zip', (req, res) => {

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

    archive.on('warning', error => {
        console.warn('ZIP 경고:', error.message);
    });

    archive.on('error', error => {

        console.error('ZIP 생성 실패:', error);

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

    if (fs.existsSync(metaFile)) {

        archive.file(metaFile, {
            name: 'metadata.json'
        });
    }

    archive.finalize();
});

// --------------------------------------------------
// Render 재시작 전 GitHub 파일 복원
// --------------------------------------------------

async function startServer() {

    if (isGithubSyncEnabled) {

        let lastError = null;

        for (let attempt = 1; attempt <= 3; attempt++) {

            try {

                await restoreUploadsFromGithub();

                lastError = null;

                break;

            } catch (error) {

                lastError = error;

                console.error(
                    `🚨 GitHub 복원 실패 (${attempt}/3):`,
                    error.message
                );

                if (attempt < 3) {

                    await new Promise(resolve => {
                        setTimeout(resolve, attempt * 3000);
                    });
                }
            }
        }

        // 복원 실패 시 빈 라이브러리로 서버를 실행하지 않음
        if (lastError) {

            throw new Error(
                `기존 파일 복원 실패로 서버 시작을 중단합니다: ${lastError.message}`
            );
        }
    }

    app.listen(PORT, () => {

        console.log(
            `🚀 FFX Cloud Studio 서버 실행 중: 포트 ${PORT}`
        );
    });
}

startServer().catch(error => {

    console.error(
        '⛔ 서버 시작 실패:',
        error.message
    );

    process.exit(1);
});

// 서버 오류 처리
app.use((error, req, res, next) => {

    console.error(
        '서버 미처리 오류:',
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({

        success: false,

        error: '서버 내부 오류가 발생했습니다.'
    });
});
