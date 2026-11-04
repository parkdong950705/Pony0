document.addEventListener('DOMContentLoaded', () => {
    const SERVER_URL = 'http://localhost:3000';

    async function fetchPresets() {
        try {
            const response = await fetch(`${SERVER_URL}/api/presets`);
            const presets = await response.json();
            const gridEl = document.getElementById('preset-grid');
            
            if (!presets || presets.length === 0) {
                gridEl.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 20px;">저장된 프리셋이 없습니다.</div>';
                return;
            }

            gridEl.innerHTML = presets.map(item => {
                const name = item.NAME || item.name;
                const thumb = item.THUMBNAIL || item.thumbnail || 'default-thumb.png';
                const thumbUrl = `${SERVER_URL}/uploads/${thumb}`;

                return `
                    <div class="preset-card">
                        <img src="${thumbUrl}" class="preset-thumb" alt="썸네일">
                        <div class="preset-info">
                            <div class="preset-name" title="${name}">${name}</div>
                            <button class="btn primary download-btn" data-filename="${name}" style="width: 100%; padding: 4px; font-size: 11px;">다운로드</button>
                        </div>
                    </div>
                `;
            }).join('');

            document.querySelectorAll('.download-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const filename = e.target.getAttribute('data-filename');
                    window.location.href = `${SERVER_URL}/api/download/${encodeURIComponent(filename)}`;
                });
            });
        } catch (err) {
            document.getElementById('preset-grid').innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #d7373f; padding: 20px;">서버 연결 실패</div>';
        }
    }

    const presetFileInput = document.getElementById('ffx-file-input');
    const thumbFileInput = document.getElementById('thumb-file-input');
    const presetFileNameSpan = document.getElementById('preset-file-name');
    const thumbFileNameSpan = document.getElementById('thumb-file-name');
    
    let selectedPresetFile = null;
    let selectedThumbFile = null;

    document.getElementById('btn-select-preset').addEventListener('click', () => presetFileInput.click());
    document.getElementById('btn-select-thumb').addEventListener('click', () => thumbFileInput.click());

    presetFileInput.addEventListener('change', (e) => {
        selectedPresetFile = e.target.files[0];
        presetFileNameSpan.textContent = selectedPresetFile ? selectedPresetFile.name : '선택된 파일 없음';
    });

    thumbFileInput.addEventListener('change', (e) => {
        selectedThumbFile = e.target.files[0];
        thumbFileNameSpan.textContent = selectedThumbFile ? selectedThumbFile.name : '선택된 이미지 없음';
    });

    const progressContainer = document.getElementById('upload-progress-container');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressPercent = document.getElementById('upload-percent');
    const statusText = document.getElementById('upload-status-text');

    document.getElementById('btn-upload-submit').addEventListener('click', () => {
        if (!selectedPresetFile) {
            alert('효과 파일을 선택해 주세요.');
            return;
        }

        const formData = new FormData();
        formData.append('presetFile', selectedPresetFile);
        if (selectedThumbFile) {
            formData.append('thumbnailFile', selectedThumbFile);
        }

        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressPercent.textContent = '0%';
        statusText.textContent = '업로드 중...';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${SERVER_URL}/api/upload`, true);

        xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                progressPercent.textContent = percent + '%';
            }
        };

        xhr.onload = function () {
            if (xhr.status === 200) {
                statusText.textContent = '✅ 업로드 완료!';
                selectedPresetFile = null;
                selectedThumbFile = null;
                presetFileNameSpan.textContent = '선택된 파일 없음';
                thumbFileNameSpan.textContent = '선택된 이미지 없음';
                presetFileInput.value = '';
                thumbFileInput.value = '';
                fetchPresets();
            } else {
                statusText.textContent = '❌ 업로드 실패';
            }
        };
        xhr.send(formData);
    });

    document.getElementById('preset-search').addEventListener('input', (e) => {
        const keyword = e.target.value.toLowerCase();
        document.querySelectorAll('.preset-card').forEach(card => {
            const name = card.querySelector('.preset-name').textContent.toLowerCase();
            card.style.display = name.includes(keyword) ? 'flex' : 'none';
        });
    });

    document.getElementById('btn-refresh').addEventListener('click', fetchPresets);
    fetchPresets();
});