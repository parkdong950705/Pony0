document.addEventListener('DOMContentLoaded', () => {
    const SERVER_URL = 'https://pony0.onrender.com';
    const DEFAULT_FILE_TEXT = '효과 파일 (.ffx / .mogrt) 선택 (선택사항)';
    const DEFAULT_THUMB_HTML = `
        <span class="material-icons-round">image</span>
        <span class="primary-text" id="thumb-name-display">썸네일/이미지 파일 선택</span>
    `;
    const NO_IMAGE = 'https://via.placeholder.com/300x180?text=No+Image';

    const fileInput = document.getElementById('file-input');
    const thumbInput = document.getElementById('thumb-input');
    const uploadBtn = document.getElementById('upload-btn');
    const gridEl = document.getElementById('preset-grid');
    const searchInput = document.getElementById('search-input');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const githubSyncBtn = document.getElementById('github-sync-btn');

    let allPresets = [];
    let currentCategoryFilter = 'all';
    let currentSearchKeyword = '';

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function githubMessage(status) {
        if (status === 'synced') return '\nGitHub에도 자동 저장되었습니다.';
        if (status === 'failed') return '\n⚠️ GitHub 동기화에는 실패했습니다. (서버 로그 확인)';
        return '';
    }

    const fileSelectTrigger = document.querySelector('.file-select-trigger');
    const thumbSelectTrigger = document.querySelector('.thumb-select-trigger');

    if (fileSelectTrigger && fileInput) {
        fileSelectTrigger.addEventListener('click', () => fileInput.click());
    }
    if (thumbSelectTrigger && thumbInput) {
        thumbSelectTrigger.addEventListener('click', () => thumbInput.click());
    }

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const fileName = fileInput.files[0] ? fileInput.files[0].name : DEFAULT_FILE_TEXT;
            document.getElementById('file-name-display').textContent = fileName;
        });
    }

    if (thumbInput) {
        thumbInput.addEventListener('change', () => {
            const file = thumbInput.files[0];
            const previewBox = document.getElementById('thumb-preview-box');

            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewBox.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <img src="${e.target.result}" class="preview-thumb-img">
                            <span class="primary-text">${escapeHtml(file.name)}</span>
                        </div>
                    `;
                };
                reader.readAsDataURL(file);
            } else {
                previewBox.innerHTML = DEFAULT_THUMB_HTML;
            }
        });
    }

    async function fetchPresets() {
        try {
            const response = await fetch(`${SERVER_URL}/api/presets`);
            allPresets = await response.json();
            renderPresets();
        } catch (error) {
            console.error('서버 연결 실패:', error);
            if (gridEl) {
                gridEl.innerHTML = '<div class="empty-state" style="color: #ff4d4d;">서버 연결에 실패했습니다.</div>';
            }
        }
    }

    function renderPresets() {
        if (!gridEl) return;

        const filtered = allPresets.filter(item => {
            const name = (item.NAME || item.name || '').toLowerCase();
            const category = item.CATEGORY || 'motion';

            const matchesSearch = name.includes(currentSearchKeyword.toLowerCase());
            const matchesTab = (currentCategoryFilter === 'all') || (category === currentCategoryFilter);

            return matchesSearch && matchesTab;
        });

        if (filtered.length === 0) {
            gridEl.innerHTML = '<div class="empty-state">검색된 프리셋이 없습니다.</div>';
            return;
        }

        gridEl.innerHTML = filtered.map(item => {
            const name = item.NAME || item.name;
            const thumb = item.THUMBNAIL || item.thumbnail;
            const thumbUrl = (thumb && thumb !== 'default-thumb.png')
                ? `${SERVER_URL}/uploads/${encodeURIComponent(thumb)}`
                : NO_IMAGE;

            let categoryLabel = '🎬 모션그래픽';
            if (item.CATEGORY === 'illustration') categoryLabel = '🎨 일러스트';
            if (item.CATEGORY === 'subtitle') categoryLabel = '💬 자막효과';

            const safeName = escapeHtml(name);

            return `
                <div class="preset-card">
                    <div class="preset-thumb-wrapper">
                        <span class="category-badge">${categoryLabel}</span>
                        <img src="${thumbUrl}" class="preset-thumb" alt="썸네일" onerror="this.onerror=null;this.src='${NO_IMAGE}'">
                    </div>
                    <div class="preset-info">
                        <div class="preset-name" title="${safeName}">${safeName}</div>
                        <div class="preset-actions">
                            <button class="btn-download download-btn" data-filename="${safeName}">
                                <span class="material-icons-round">download</span> 다운로드
                            </button>
                            <button class="btn-delete delete-btn" data-filename="${safeName}" title="파일 삭제">
                                <span class="material-icons-round">delete</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                currentSearchKeyword = searchInput.value.trim();
                renderPresets();
            }
        });
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategoryFilter = btn.getAttribute('data-tab');
            renderPresets();
        });
    });

    if (uploadBtn) {
        uploadBtn.addEventListener('click', async () => {
            const file = fileInput?.files[0];
            const thumb = thumbInput?.files[0];
            const selectedCategory = document.querySelector('input[name="category"]:checked')?.value || 'motion';

            if (!file && !thumb) {
                alert('업로드할 효과 파일(.ffx/.mogrt) 또는 이미지 파일을 최소 하나 이상 선택해주세요.');
                return;
            }

            const formData = new FormData();
            // category를 파일보다 먼저 append
            formData.append('category', selectedCategory);
            if (file) formData.append('effectFile', file);
            if (thumb) formData.append('thumbFile', thumb);

            try {
                uploadBtn.innerHTML = '<span class="material-icons-round">sync</span> 업로드 중...';
                uploadBtn.disabled = true;

                const response = await fetch(`${SERVER_URL}/api/upload`, {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    const data = await response.json().catch(() => ({}));
                    alert('성공적으로 업로드되었습니다!' + githubMessage(data.github));
                    if (fileInput) fileInput.value = '';
                    if (thumbInput) thumbInput.value = '';
                    document.getElementById('file-name-display').textContent = DEFAULT_FILE_TEXT;
                    document.getElementById('thumb-preview-box').innerHTML = DEFAULT_THUMB_HTML;
                    fetchPresets();
                } else {
                    alert('업로드에 실패했습니다.');
                }
            } catch (error) {
                console.error('업로드 에러:', error);
                alert('업로드 중 오류가 발생했습니다.');
            } finally {
                uploadBtn.innerHTML = '<span class="material-icons-round">rocket_launch</span> 클라우드에 안전하게 업로드하기';
                uploadBtn.disabled = false;
            }
        });
    }

    if (githubSyncBtn) {
        githubSyncBtn.addEventListener('click', () => {
            window.location.href = `${SERVER_URL}/api/download-sync-zip`;
        });
    }

    if (gridEl) {
        gridEl.addEventListener('click', async (e) => {
            const downloadBtn = e.target.closest('.download-btn');
            const deleteBtn = e.target.closest('.delete-btn');

            if (downloadBtn) {
                const filename = downloadBtn.getAttribute('data-filename');
                window.location.href = `${SERVER_URL}/uploads/${encodeURIComponent(filename)}`;
            }

            if (deleteBtn) {
                const filename = deleteBtn.getAttribute('data-filename');
                if (confirm(`"${filename}" 파일 및 연관된 썸네일을 모두 삭제하시겠습니까?`)) {
                    try {
                        const response = await fetch(`${SERVER_URL}/api/delete/${encodeURIComponent(filename)}`, {
                            method: 'DELETE'
                        });
                        if (response.ok) {
                            const data = await response.json().catch(() => ({}));
                            alert('파일이 삭제되었습니다.' + githubMessage(data.github));
                            fetchPresets();
                        } else {
                            alert('파일 삭제에 실패했습니다.');
                        }
                    } catch (err) {
                        console.error('삭제 에러:', err);
                        alert('삭제 중 오류가 발생했습니다.');
                    }
                }
            }
        });
    }

    fetchPresets();
});