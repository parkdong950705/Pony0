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

// 🌐 깃허브 API 통신 함수 (한글 및 특수문자 에러 완벽 해결)
function syncFileToGithub(fileName, fileBuffer) {
    if (!isGithubSyncEnabled) return;

    // 한글 및 특수문자 파일명을 안전하게 인코딩
    const encodedPath = encodeURIComponent(fileName);

    const getOptions = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/uploads/${encodedPath}`,
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
            sendPutRequest(fileName, encodedPath, fileBuffer, sha);
        });
    });

    reqGet.on('error', () => {
        sendPutRequest(fileName, encodedPath, fileBuffer, null);
    });
    reqGet.end();
}

function sendPutRequest(fileName, encodedPath, fileBuffer, sha) {
    const payload = {
        message: `Auto-sync: update uploads/${fileName}`,
        content: fileBuffer.toString('base64'),
        branch: GITHUB_BRANCH
    };
    if (sha) payload.sha = sha;

    const dataString = JSON.stringify(payload);
    const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/uploads/${encodedPath}`,
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

    const encodedPath = encodeURIComponent(fileName);
    const getOptions = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/uploads/${encodedPath}`,
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
                    sendDeleteRequest(fileName, encodedPath, sha);
                } catch (e) {}
            }
        });
    });
    reqGet.end();
}

function sendDeleteRequest(fileName, encodedPath, sha) {
    const payload = {
        message: `Auto-sync: delete uploads/${fileName}`,
        sha: sha,
        branch: GITHUB_BRANCH
    };

    const dataString = JSON.stringify(payload);
    const options = {
        hostname: