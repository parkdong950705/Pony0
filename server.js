const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');

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

// 프리셋 및 이미지 목록 조회 API
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

// 파일 업로드 처리 API (한글 파일명 및 특수문자 에러 완벽 해결)
app.post('/api/upload', upload.fields([
    { name: 'effectFile', maxCount: 1 },
    { name: 'thumbFile', maxCount: 1 }
]), (req, res) => {
    try {
        const category = req.body.category || 'motion';
        const metadata = loadMetadata();

        if (req.files['effectFile']) {
            const effName = req.files['effectFile'][0].originalname;
            const decodedEffName = Buffer.from(effName, 'latin1').toString('utf8');
            metadata[decodedEffName] = category;
            metadata[path.parse(decodedEffName).name] = category;
        }
        if (req.files['thumbFile']) {
            const thumbName = req.files['thumbFile'][0].originalname;
            const decodedThumbName = Buffer.from(thumbName, 'latin1').toString('utf8');
            metadata[decodedThumbName] = category;
            metadata[path.parse(decodedThumbName).name] = category;
        }

        saveMetadata(metadata);
        res.json({ success: true, message: '성공적으로 업로드되었습니다.', category });
    } catch (error) {
        console.error('업로드 처리 에러:', error);
        res.status(500).json({ error: '파일 업로드 실패' });
    }
});

// 파일 삭제 API (효과 파일 및 썸네일 동시 삭제)
app.delete('/api/delete/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const baseName = path.parse(filename).name;
        const filePath = path.join(uploadsDir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            if (path.parse(file).name === baseName && file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                const thumbPath = path.join(uploadsDir, file);
                if (fs.existsSync(thumbPath)) {
                    fs.unlinkSync(thumbPath);
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

// 깃허브 백업용 ZIP 다운로드 API
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