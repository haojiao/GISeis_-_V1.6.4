// ==UserScript==
// @name         GISeis 测量质检助手 V1.6.4
// @namespace    https://giseis.com/
// @version      1.6.5
// @description  编号与照片/视频检查、自动通过或不通过并填写原因、手动开始/停止
// @match        *://giseis.com/Fun/OpenCheck_Chk_Sur*
// @match        *://*.giseis.com/Fun/OpenCheck_Chk_Sur*
// @match        *://giseis.com/html/M_CHK/Q_Check_Survey.html*
// @match        *://*.giseis.com/html/M_CHK/Q_Check_Survey.html*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.6.5';
    const PANEL_ID = 'giseis-qc-helper';
    const FLOAT_ID = 'giseis-qc-float';
    const MISSING_MEDIA_REASON = '缺少照片或视频';

    // ============================================================
    // GISeis 字段
    // ============================================================

    const FIELD_IDS = {
        line: 'valLineName',
        calcLine: 'valCalLineName',
        point: 'valPointName',
        calcPoint: 'valCalPointName'
    };

    // ============================================================
    // 自动审核参数
    // ============================================================

    // 每两条至少间隔 6 秒
    const MIN_INTERVAL_MS = 6000;

    // 编号稳定时间
    const STABLE_MS = 1200;

    // 点击后最长确认时间
    const VERIFY_TIMEOUT_MS = 8000;

    // 提交状态轮询
    const VERIFY_POLL_MS = 400;

    // 最大允许输入数量，防止误输入特别大的数字
    const MAX_ALLOWED_COUNT = 100;

    // ============================================================
    // 状态
    // ============================================================

    let refreshTimer = null;
    let lastSignature = '';

    // 每个原因输入框只在页面加载或重建后清空一次
    const clearedReasonInputs = new WeakSet();
    const autoRejectionReasons = new WeakMap();
    let mediaObservation = null;

    // 是否已经点击“开始审核”
    let autoRunning = false;

    // 是否正在提交
    let busy = false;

    // 用户设置的本次目标数量
    let targetCount = 6;

    // 已确认处理数量（通过和不通过合计）
    let successCount = 0;
    let passCount = 0;
    let rejectCount = 0;

    // 尝试次数
    let attemptCount = 0;

    // 上次成功时间
    let lastSuccessAt = 0;

    // 当前候选记录、审核动作和原因的稳定签名
    let candidateKey = '';

    // 当前记录稳定起始时间
    let candidateSince = 0;

    // 上一条成功记录
    let lastSuccessfulKey = '';

    // 状态文字
    let statusMessage = '等待开始';

    let statusClass = 'unknown';


    // ============================================================
    // 基础工具
    // ============================================================

    function cleanText(v) {

        if (
            v === null ||
            v === undefined
        ) {
            return '';
        }

        return String(v)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }


    function getElementText(el) {

        if (!el) {
            return null;
        }

        try {

            const value =
                ['INPUT', 'TEXTAREA', 'SELECT']
                    .includes(el.tagName)

                    ? el.value

                    : (
                        el.textContent ||
                        el.innerText ||
                        ''
                    );

            return cleanText(value) || null;

        } catch (e) {

            return null;
        }
    }


    // ============================================================
    // iframe 深度查找
    // ============================================================

    function findElementDeep(
        id,
        rootWindow = window,
        visited = new Set()
    ) {

        if (
            !rootWindow ||
            visited.has(rootWindow)
        ) {
            return null;
        }

        visited.add(rootWindow);

        let doc;

        try {

            doc = rootWindow.document;

        } catch (e) {

            return null;
        }

        if (!doc) {
            return null;
        }


        // 当前 document
        try {

            const el =
                doc.getElementById(id);

            if (el) {

                return {
                    element: el,
                    document: doc,
                    window: rootWindow
                };
            }

        } catch (e) {}


        // iframe
        let frames = [];

        try {

            frames = [
                ...doc.querySelectorAll('iframe')
            ];

        } catch (e) {}


        for (const iframe of frames) {

            try {

                const result =
                    findElementDeep(
                        id,
                        iframe.contentWindow,
                        visited
                    );

                if (result) {
                    return result;
                }

            } catch (e) {}
        }

        return null;
    }


    function getTextByIdDeep(id) {

        const result =
            findElementDeep(id);

        return result
            ? getElementText(result.element)
            : null;
    }


    // ============================================================
    // 页面加载后清空审核不通过原因
    // ============================================================

    function clearRejectionReasonOnce() {

        const result =
            findElementDeep('snpNPReason');

        if (
            !result ||
            clearedReasonInputs.has(result.element)
        ) {
            return;
        }

        const input = result.element;

        input.value = '';
        input.defaultValue = '';

        // 用户编辑后，自动检测不再改写这段原因
        for (const eventName of ['input', 'change']) {
            input.addEventListener(eventName, () => {
                autoRejectionReasons.delete(input);
            });
        }

        // 后续定时检查保留用户在本次页面中手动填写的原因
        clearedReasonInputs.add(input);
    }


    // ============================================================
    // 当前记录的照片/视频检查
    // ============================================================

    function readMediaInfo(n) {

        const reason = findElementDeep('snpNPReason');
        const input = reason ? reason.element : null;
        const container = reason
            ? reason.document.getElementById('DivImage')
            : null;
        const key = getRecordKey(n);
        const media = {
            status: 'unknown',
            hasPhoto: false,
            hasVideo: false,
            input
        };

        if (!key || !container) {
            mediaObservation = null;
            return media;
        }

        // 限定附件区域，避免把页面图标当成照片
        const sources = [...container.querySelectorAll('img, video, video source')]
            .map(element => ({
                tag: element.tagName,
                src: (element.getAttribute('src') || '').trim()
            }));
        const validSources = sources.filter(source =>
            source.src &&
            !/^(?:#|about:|javascript:)/i.test(source.src)
        );

        media.hasPhoto = validSources.some(source => source.tag === 'IMG');
        media.hasVideo = validSources.some(source =>
            source.tag === 'VIDEO' || source.tag === 'SOURCE'
        );

        const loading = reason.document.readyState === 'loading' ||
            container.getAttribute('aria-busy') === 'true' ||
            !!container.querySelector('[aria-busy="true"]') ||
            /正在加载|加载中|\bloading\b/i.test(container.textContent || '');
        const signature = JSON.stringify({ sources, loading });

        if (
            !mediaObservation ||
            mediaObservation.key !== key ||
            mediaObservation.input !== input ||
            mediaObservation.container !== container ||
            mediaObservation.signature !== signature
        ) {
            mediaObservation = {
                key, input, container, signature,
                since: Date.now()
            };
        }

        // 附件和记录稳定后再下结论，给异步插入留出时间
        if (loading || Date.now() - mediaObservation.since < STABLE_MS) {
            media.status = 'loading';
        } else {
            media.status = media.hasPhoto || media.hasVideo
                ? 'present'
                : 'missing';
        }

        return media;
    }


    function getRejectionReasons(n, media) {

        const reasons = [];

        if (n.lineCheck.status === 'bad') {
            reasons.push({
                summary: '线号与归算线号不一致',
                detail: `线号与归算线号不一致（${n.line}≠${n.calcLine}）`
            });
        }

        if (n.pointCheck.status === 'bad') {
            reasons.push({
                summary: '点号与归算点号不一致',
                detail: `点号与归算点号不一致（${n.point}≠${n.calcPoint}）`
            });
        }

        if (media.status === 'missing') {
            reasons.push({ summary: MISSING_MEDIA_REASON, detail: MISSING_MEDIA_REASON });
        }

        return reasons;
    }


    function composeRejectionReason(input, reasons, manual = '') {

        const limits = ['maxlength', 'length']
            .map(name => Number(input.getAttribute(name)))
            .filter(limit => Number.isInteger(limit) && limit > 0);
        const limit = limits.length ? Math.min(...limits) : Infinity;
        const base = cleanText(manual) ? manual : '';
        const existingParts = base.split(/[；;\r\n]/).map(cleanText);
        const missing = reasons.filter(reason =>
            !existingParts.includes(reason.detail) &&
            !existingParts.includes(reason.summary)
        );
        const join = type => {
            const suffix = missing.map(reason => reason[type]).join('；');
            return base && suffix ? `${base}；${suffix}` : (base || suffix);
        };

        let text = join('detail');

        if (text.length > limit) {
            text = join('summary');
        }

        return { ok: text.length <= limit, text, manual: base };
    }


    function writeRejectionReason(input, result) {

        input.value = result.text;

        if (result.text !== result.manual) {
            autoRejectionReasons.set(input, {
                value: result.text,
                manual: result.manual
            });
        } else {
            autoRejectionReasons.delete(input);
        }
    }


    function updateRejectionReason(n, media) {

        const input = media.input;

        if (!input) {
            return;
        }

        const previous = autoRejectionReasons.get(input);
        const ownsValue = previous && input.value === previous.value;

        if (!ownsValue) {
            autoRejectionReasons.delete(input);

            // 被动检查保留用户输入；自动提交时再追加判断理由
            if (cleanText(input.value)) {
                return;
            }
        }

        const result = composeRejectionReason(
            input,
            getRejectionReasons(n, media),
            ownsValue ? previous.manual : ''
        );

        if (result.ok) {
            writeRejectionReason(input, result);
        }
    }


    function prepareRejectionReason(n, media) {

        const input = media.input;
        const reasons = getRejectionReasons(n, media);

        if (!input || input.disabled || input.readOnly || !reasons.length) {
            return { ok: false, reason: '不通过原因输入框不可用或原因未确认' };
        }

        const previous = autoRejectionReasons.get(input);
        const manual = previous && input.value === previous.value
            ? previous.manual
            : input.value;
        const result = composeRejectionReason(input, reasons, manual);

        if (!result.ok || !cleanText(result.text)) {
            return { ok: false, reason: '无法在输入框长度限制内完整填写不通过原因' };
        }

        writeRejectionReason(input, result);

        if (input.value !== result.text) {
            return { ok: false, reason: '不通过原因填写未确认' };
        }

        return { ok: true, text: result.text };
    }


    function getReviewDecision(n, media) {

        const key = getRecordKey(n);
        const reasons = getRejectionReasons(n, media);
        const reason = reasons.map(item => item.detail).join('；');

        if (!key) {
            return { action: 'wait', key, reason, message: '等待编号' };
        }

        if (media.status !== 'present' && media.status !== 'missing') {
            return { action: 'wait', key, reason, message: '等待照片/视频区域' };
        }

        return { action: reasons.length ? 'reject' : 'pass', key, reason };
    }


    function getDecisionSignature(decision) {

        return JSON.stringify({
            key: decision.key,
            action: decision.action,
            reason: decision.reason
        });
    }


    // ============================================================
    // 编号标准化
    // ============================================================

    function normalizeNumber(v) {

        if (
            v === null ||
            v === undefined
        ) {
            return null;
        }

        const str =
            cleanText(v);

        if (!str) {
            return null;
        }


        // 1652.0 = 1652
        // 1420.50 = 1420.5

        if (
            /^[+-]?\d+(?:\.\d+)?$/
                .test(str)
        ) {

            const n =
                Number(str);

            if (!Number.isNaN(n)) {

                return String(n);
            }
        }

        return str.toUpperCase();
    }


    // ============================================================
    // 编号比较
    // ============================================================

    function compareValue(a, b) {

        if (!a || !b) {

            return {
                status: 'unknown',
                text: '？未读取'
            };
        }


        if (
            normalizeNumber(a) ===
            normalizeNumber(b)
        ) {

            return {
                status: 'ok',
                text: '✓ 匹配'
            };
        }


        return {
            status: 'bad',
            text: '✗ 不匹配'
        };
    }


    // ============================================================
    // 读取编号
    // ============================================================

    function readNumberInfo() {

        const line =
            getTextByIdDeep(
                FIELD_IDS.line
            );

        const calcLine =
            getTextByIdDeep(
                FIELD_IDS.calcLine
            );

        const point =
            getTextByIdDeep(
                FIELD_IDS.point
            );

        const calcPoint =
            getTextByIdDeep(
                FIELD_IDS.calcPoint
            );


        return {

            line,
            calcLine,
            point,
            calcPoint,

            lineCheck:
                compareValue(
                    line,
                    calcLine
                ),

            pointCheck:
                compareValue(
                    point,
                    calcPoint
                )
        };
    }


    // ============================================================
    // 是否匹配
    // ============================================================

    function isMatched(n) {

        return (

            n.lineCheck.status === 'ok' &&

            n.pointCheck.status === 'ok'
        );
    }


    // ============================================================
    // 记录签名
    // ============================================================

    function getRecordKey(n) {

        if (
            !n.line ||
            !n.calcLine ||
            !n.point ||
            !n.calcPoint
        ) {

            return '';
        }


        return [

            normalizeNumber(n.line),

            normalizeNumber(n.calcLine),

            normalizeNumber(n.point),

            normalizeNumber(n.calcPoint)

        ].join('|');
    }


    // ============================================================
    // CSS
    // ============================================================

    function createStyle() {

        if (
            document.getElementById(
                'giseis-qc-style'
            )
        ) {
            return;
        }


        const style =
            document.createElement(
                'style'
            );


        style.id =
            'giseis-qc-style';


        style.textContent = `

#${PANEL_ID}{

    position:fixed;

    right:20px;
    bottom:20px;

    width:330px;

    background:#fff;

    box-shadow:
        0 5px 25px
        rgba(0,0,0,.28);

    border-radius:9px;

    overflow:hidden;

    z-index:2147483647;

    font:
        14px
        "Microsoft YaHei",
        Arial;

    color:#333;
}


#${PANEL_ID} .header{

    height:44px;

    padding:0 10px 0 14px;

    background:#1677ff;

    color:#fff;

    display:flex;

    align-items:center;

    justify-content:
        space-between;

    font-weight:bold;

    cursor:move;

    user-select:none;
}


#${PANEL_ID} .header-left{

    display:flex;

    align-items:center;

    gap:7px;
}


#${PANEL_ID} .close-btn{

    width:28px;

    height:28px;

    display:flex;

    align-items:center;

    justify-content:center;

    border-radius:5px;

    cursor:pointer;

    font-size:20px;

    line-height:20px;
}


#${PANEL_ID} .close-btn:hover{

    background:
        rgba(255,255,255,.2);
}


#${PANEL_ID} .body{

    padding:
        10px
        12px
        12px;
}


#${PANEL_ID} .section-title{

    font-weight:bold;

    padding:
        5px
        0
        7px;

    border-bottom:
        1px solid #eee;
}


#${PANEL_ID} .row{

    min-height:33px;

    display:flex;

    align-items:center;

    justify-content:
        space-between;

    gap:10px;

    border-bottom:
        1px solid #f0f0f0;
}


#${PANEL_ID} .row strong{

    text-align:right;

    word-break:
        break-all;

    max-width:190px;
}


#${PANEL_ID} .ok{

    color:#16a34a;
}


#${PANEL_ID} .bad{

    color:#dc2626;
}


#${PANEL_ID} .unknown{

    color:#d97706;
}


#${PANEL_ID} .settings{

    padding:
        9px 0;
}


#${PANEL_ID} .count-row{

    display:flex;

    align-items:center;

    gap:8px;

    margin-bottom:8px;
}


#${PANEL_ID} .count-row input{

    width:70px;

    height:30px;

    box-sizing:border-box;

    border:
        1px solid #d1d5db;

    border-radius:5px;

    padding:
        0 8px;

    text-align:center;

    font-size:14px;
}


#${PANEL_ID} .buttons{

    display:flex;

    gap:8px;
}


#${PANEL_ID} button{

    flex:1;

    height:36px;

    border:0;

    border-radius:5px;

    color:#fff;

    cursor:pointer;

    font-size:14px;
}


#${PANEL_ID} #q-start{

    background:#16a34a;
}


#${PANEL_ID} #q-start:hover{

    background:#15803d;
}


#${PANEL_ID} #q-stop{

    background:#dc2626;
}


#${PANEL_ID} #q-stop:hover{

    background:#b91c1c;
}


#${PANEL_ID} button:disabled{

    background:#9ca3af !important;

    cursor:not-allowed;
}


#${PANEL_ID} .summary{

    margin-top:10px;

    padding:
        12px
        8px;

    text-align:center;

    border-radius:6px;

    font-size:16px;

    font-weight:bold;
}


#${PANEL_ID} .summary-ok{

    background:#ecfdf3;

    color:#15803d;

    border:
        1px solid #bbf7d0;
}


#${PANEL_ID} .summary-bad{

    background:#fef2f2;

    color:#dc2626;

    border:
        1px solid #fecaca;
}


#${PANEL_ID} .summary-warn{

    background:#fff7ed;

    color:#c2410c;

    border:
        1px solid #fed7aa;
}


/* 关闭以后显示的小悬浮按钮 */

#${FLOAT_ID}{

    position:fixed;

    right:20px;
    bottom:20px;

    width:52px;
    height:52px;

    border-radius:50%;

    background:#1677ff;

    color:#fff;

    display:none;

    align-items:center;

    justify-content:center;

    box-shadow:
        0 4px 15px
        rgba(0,0,0,.3);

    z-index:2147483647;

    cursor:pointer;

    font-size:23px;

    user-select:none;
}

`;


        document.head
            .appendChild(style);
    }


    // ============================================================
    // 创建面板
    // ============================================================

    function createPanel() {

        createStyle();


        let panel =
            document.getElementById(
                PANEL_ID
            );


        if (panel) {

            return panel;
        }


        panel =
            document.createElement(
                'div'
            );


        panel.id =
            PANEL_ID;


        panel.innerHTML = `

<div class="header">

    <div class="header-left">

        <span>
            🛡
        </span>

        <span>
            测量质检助手 V${VERSION}
        </span>

    </div>

    <div
        class="close-btn"
        title="关闭"
    >
        ×
    </div>

</div>


<div class="body">


    <div class="section-title">

        编号检查

    </div>


    <div class="row">

        <span>线号</span>

        <strong id="q-line">
            -
        </strong>

    </div>


    <div class="row">

        <span>归算线号</span>

        <strong id="q-calc-line">
            -
        </strong>

    </div>


    <div class="row">

        <span>线号检查</span>

        <strong id="q-line-check">
            -
        </strong>

    </div>


    <div class="row">

        <span>点号</span>

        <strong id="q-point">
            -
        </strong>

    </div>


    <div class="row">

        <span>归算点号</span>

        <strong id="q-calc-point">
            -
        </strong>

    </div>


    <div class="row">

        <span>点号检查</span>

        <strong id="q-point-check">
            -
        </strong>

    </div>


    <div class="row">

        <span>照片/视频</span>

        <strong id="q-media" class="unknown">正在检测</strong>

    </div>


    <div class="section-title"
         style="margin-top:8px;">

        自动质检设置

    </div>


    <div class="settings">


        <div class="count-row">

            <span>
                质检数量
            </span>

            <input
                id="q-count"
                type="number"
                min="1"
                max="${MAX_ALLOWED_COUNT}"
                value="6"
            >

            <span>
                条
            </span>

        </div>


        <div class="buttons">

            <button
                id="q-start"
                type="button"
            >
                ▶ 开始审核
            </button>


            <button
                id="q-stop"
                type="button"
                disabled
            >
                ■ 停止审核
            </button>

        </div>

    </div>


    <div class="row">

        <span>
            审核进度
        </span>

        <strong
            id="q-progress"
            class="unknown"
        >
            0 / 6
        </strong>

    </div>


    <div class="row">

        <span>审核结果</span>

        <strong id="q-results">通过 0 / 不通过 0</strong>

    </div>


    <div class="row">

        <span>
            当前状态
        </span>

        <strong
            id="q-auto"
            class="unknown"
        >
            等待开始
        </strong>

    </div>


    <div
        id="q-summary"
        class="
            summary
            summary-warn
        "
    >

        正在读取编号

    </div>


</div>

`;


        document.body
            .appendChild(panel);


        // ========================================================
        // 创建关闭后的悬浮按钮
        // ========================================================

        let floatBtn =
            document.getElementById(
                FLOAT_ID
            );


        if (!floatBtn) {

            floatBtn =
                document.createElement(
                    'div'
                );


            floatBtn.id =
                FLOAT_ID;


            floatBtn.textContent =
                '🛡';


            floatBtn.title =
                '打开测量质检助手';


            document.body
                .appendChild(
                    floatBtn
                );
        }


        // ========================================================
        // 关闭
        // ========================================================

        panel
            .querySelector(
                '.close-btn'
            )
            .addEventListener(
                'click',
                e => {

                    e.stopPropagation();

                    panel.style.display =
                        'none';

                    floatBtn.style.display =
                        'flex';
                }
            );


        // ========================================================
        // 重新打开
        // ========================================================

        floatBtn
            .addEventListener(
                'click',
                () => {

                    panel.style.display =
                        'block';

                    floatBtn.style.display =
                        'none';
                }
            );


        // ========================================================
        // 开始审核
        // ========================================================

        panel
            .querySelector(
                '#q-start'
            )
            .addEventListener(
                'click',
                startReview
            );


        // ========================================================
        // 停止审核
        // ========================================================

        panel
            .querySelector(
                '#q-stop'
            )
            .addEventListener(
                'click',
                stopReview
            );


        // ========================================================
        // 可拖动
        // ========================================================

        enableDrag(
            panel,
            panel.querySelector(
                '.header'
            )
        );


        return panel;
    }


    // ============================================================
    // 拖动窗口
    // ============================================================

    function enableDrag(
        panel,
        handle
    ) {

        let dragging = false;

        let offsetX = 0;

        let offsetY = 0;


        handle.addEventListener(
            'mousedown',
            e => {

                // 点击关闭按钮时不拖动
                if (
                    e.target.closest(
                        '.close-btn'
                    )
                ) {

                    return;
                }


                dragging = true;


                const rect =
                    panel.getBoundingClientRect();


                offsetX =
                    e.clientX -
                    rect.left;


                offsetY =
                    e.clientY -
                    rect.top;


                // 从 right/bottom 模式
                // 转为 left/top 模式

                panel.style.left =
                    rect.left + 'px';


                panel.style.top =
                    rect.top + 'px';


                panel.style.right =
                    'auto';


                panel.style.bottom =
                    'auto';


                e.preventDefault();
            }
        );


        document.addEventListener(
            'mousemove',
            e => {

                if (!dragging) {
                    return;
                }


                let x =
                    e.clientX -
                    offsetX;


                let y =
                    e.clientY -
                    offsetY;


                // 不允许整个窗口拖出屏幕

                x =
                    Math.max(
                        0,
                        Math.min(
                            x,
                            window.innerWidth -
                            panel.offsetWidth
                        )
                    );


                y =
                    Math.max(
                        0,
                        Math.min(
                            y,
                            window.innerHeight -
                            panel.offsetHeight
                        )
                    );


                panel.style.left =
                    x + 'px';


                panel.style.top =
                    y + 'px';
            }
        );


        document.addEventListener(
            'mouseup',
            () => {

                dragging = false;
            }
        );
    }


    // ============================================================
    // 面板字段
    // ============================================================

    function setField(
        id,
        value,
        status = null
    ) {

        const el =
            document
                .getElementById(
                    PANEL_ID
                )
                ?.querySelector(
                    '#' + id
                );


        if (!el) {
            return;
        }


        el.textContent =
            value ?? '-';


        el.classList.remove(
            'ok',
            'bad',
            'unknown'
        );


        if (status) {

            el.classList.add(
                status
            );
        }
    }


    // ============================================================
    // 更新进度
    // ============================================================

    function updateProgress() {

        setField(
            'q-progress',

            `${successCount} / ${targetCount}`,

            autoRunning
                ? 'unknown'
                : (
                    successCount >= targetCount
                        ? 'ok'
                        : 'unknown'
                )
        );


        setField(
            'q-auto',
            statusMessage,
            statusClass
        );

        setField('q-results', `通过 ${passCount} / 不通过 ${rejectCount}`);
    }


    // ============================================================
    // 更新编号状态
    // ============================================================

    function updateSummary(n) {

        const el =
            document
                .getElementById(
                    PANEL_ID
                )
                ?.querySelector(
                    '#q-summary'
                );


        if (!el) {
            return;
        }


        el.classList.remove(
            'summary-ok',
            'summary-bad',
            'summary-warn'
        );


        if (
            n.lineCheck.status === 'bad' ||
            n.pointCheck.status === 'bad'
        ) {

            el.textContent =
                '✗ 编号不匹配';

            el.classList.add(
                'summary-bad'
            );

            return;
        }


        if (
            n.lineCheck.status === 'unknown' ||
            n.pointCheck.status === 'unknown'
        ) {

            el.textContent =
                '⚠ 请人工核对';

            el.classList.add(
                'summary-warn'
            );

            return;
        }


        el.textContent =
            '✓ 编号质检通过';

        el.classList.add(
            'summary-ok'
        );
    }


    function updatePanel(n) {

        setField(
            'q-line',
            n.line || '-'
        );


        setField(
            'q-calc-line',
            n.calcLine || '-'
        );


        setField(
            'q-line-check',
            n.lineCheck.text,
            n.lineCheck.status
        );


        setField(
            'q-point',
            n.point || '-'
        );


        setField(
            'q-calc-point',
            n.calcPoint || '-'
        );


        setField(
            'q-point-check',
            n.pointCheck.text,
            n.pointCheck.status
        );


        updateSummary(n);

        updateProgress();
    }


    // ============================================================
    // 开始审核
    // ============================================================

    function startReview() {

        if (busy) {
            return;
        }


        const panel =
            document.getElementById(
                PANEL_ID
            );


        const input =
            panel.querySelector(
                '#q-count'
            );


        let count =
            parseInt(
                input.value,
                10
            );


        if (
            !Number.isFinite(count) ||
            count < 1
        ) {

            alert(
                '请输入大于 0 的质检数量。'
            );

            return;
        }


        if (
            count >
            MAX_ALLOWED_COUNT
        ) {

            alert(
                `单次最多允许输入 ${MAX_ALLOWED_COUNT} 条。`
            );

            return;
        }


        targetCount =
            count;


        // 每次点击开始
        // 都作为新的一轮任务

        successCount = 0;
        passCount = 0;
        rejectCount = 0;

        attemptCount = 0;

        lastSuccessAt = 0;

        candidateKey = '';

        candidateSince = 0;

        lastSuccessfulKey = '';


        autoRunning = true;


        statusMessage =
            `已启动 0/${targetCount}`;


        statusClass =
            'ok';


        input.disabled =
            true;


        panel
            .querySelector(
                '#q-start'
            )
            .disabled =
            true;


        panel
            .querySelector(
                '#q-stop'
            )
            .disabled =
            false;


        updateProgress();


        console.warn(

            `[GISeis V${VERSION}] ` +

            `开始自动审核，` +

            `目标=${targetCount}`
        );


        refresh(true);
    }


    // ============================================================
    // 停止审核
    // ============================================================

    function stopReview() {

        autoRunning =
            false;


        candidateKey = '';

        candidateSince = 0;


        statusMessage =
            `已停止 ${successCount}/${targetCount}`;


        statusClass =
            'bad';


        restoreControls();

        updateProgress();


        console.warn(

            `[GISeis V${VERSION}] ` +

            `用户停止自动审核`
        );
    }


    // ============================================================
    // 恢复按钮
    // ============================================================

    function restoreControls() {

        const panel =
            document.getElementById(
                PANEL_ID
            );


        if (!panel) {
            return;
        }


        panel
            .querySelector(
                '#q-count'
            )
            .disabled =
            false;


        panel
            .querySelector(
                '#q-start'
            )
            .disabled =
            false;


        panel
            .querySelector(
                '#q-stop'
            )
            .disabled =
            true;
    }


    // ============================================================
    // 按审核结果定位按钮，并核对 ID 和按钮文字
    // ============================================================

    function getReviewButton(action, doc = null) {

        const id = action === 'reject' ? 'btnUnPass' : 'btnPass';
        const label = action === 'reject' ? '不通过' : '通过';
        const result = doc
            ? { element: doc.getElementById(id) }
            : findElementDeep(id);
        const btn = result ? result.element : null;

        if (!btn || btn.id !== id || cleanText(btn.value || btn.textContent || '') !== label) {
            return null;
        }

        return btn;
    }


    // ============================================================
    // 按钮是否可用
    // ============================================================

    function buttonUsable(btn) {

        if (!btn) {
            return false;
        }


        try {

            if (btn.disabled) {
                return false;
            }


            if (
                btn.getAttribute(
                    'disabled'
                ) !== null
            ) {

                return false;
            }


            const win =
                btn.ownerDocument
                    .defaultView;


            const style =
                win.getComputedStyle(
                    btn
                );


            const rect =
                btn.getBoundingClientRect();


            if (
                style.display === 'none' ||
                style.visibility === 'hidden'
            ) {

                return false;
            }


            if (
                rect.width <= 0 ||
                rect.height <= 0
            ) {

                return false;
            }


            return true;


        } catch (e) {

            return false;
        }
    }


    function sleep(ms) {

        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }


    // ============================================================
    // 点击后验证
    // ============================================================

    function pauseAutoReview(message) {

        autoRunning = false;
        candidateKey = '';
        candidateSince = 0;
        statusMessage = `${message}，已停止 ${successCount}/${targetCount}`;
        statusClass = 'bad';
        restoreControls();
        updateProgress();
    }


    async function verifySubmission(
        oldKey,
        oldButton,
        action,
        originWindow = oldButton.ownerDocument.defaultView
    ) {

        const start = Date.now();
        const submittedURL = oldButton.ownerDocument.URL;
        let confirmation = '';
        let confirmationSince = 0;

        while (Date.now() - start < VERIFY_TIMEOUT_MS) {
            await sleep(VERIFY_POLL_MS);

            let currentDocument;

            try {
                currentDocument = originWindow.document;
            } catch (e) {
                confirmation = '';
                continue;
            }

            if (!currentDocument || currentDocument.readyState === 'loading') {
                confirmation = '';
                continue;
            }

            const newKey = getRecordKey(readNumberInfo());
            const button = currentDocument.getElementById(
                action === 'reject' ? 'btnUnPass' : 'btnPass'
            );
            const otherButton = currentDocument.getElementById(
                action === 'reject' ? 'btnPass' : 'btnUnPass'
            );
            const reasonInput = currentDocument.getElementById('snpNPReason');
            const numberFields = Object.values(FIELD_IDS)
                .some(id => currentDocument.getElementById(id));
            let signal = '';

            if (newKey && newKey !== oldKey) {
                signal = `record:${newKey}`;
            } else if (
                !newKey && !button && !otherButton && !reasonInput && !numberFields &&
                currentDocument.readyState === 'complete' &&
                currentDocument.URL === submittedURL &&
                !/^about:blank(?:$|[?#])/i.test(currentDocument.URL || '')
            ) {
                signal = 'review-removed';
            }

            // 临时禁用、隐藏按钮或 iframe 加载空白不作为提交成功
            if (!signal) {
                confirmation = '';
                continue;
            }

            if (signal !== confirmation) {
                confirmation = signal;
                confirmationSince = Date.now();
            } else if (Date.now() - confirmationSince >= STABLE_MS) {
                return {
                    ok: true,
                    reason: signal === 'review-removed' ? '审核区域已移除' : '记录已稳定切换'
                };
            }
        }

        return { ok: false, reason: '提交后未检测到稳定确认信号' };
    }


    // ============================================================
    // 自动审核：正常记录通过，问题记录填写原因并不通过
    // ============================================================

    async function tryAutoReview() {

        if (!autoRunning || busy) {
            return;
        }

        if (successCount >= targetCount) {
            finishReview();
            return;
        }

        busy = true;

        try {
            const n = readNumberInfo();
            const media = readMediaInfo(n);
            updateRejectionReason(n, media);
            const decision = getReviewDecision(n, media);

            if (decision.action === 'wait') {
                candidateKey = '';
                candidateSince = 0;
                statusMessage = `${decision.message} ${successCount}/${targetCount}`;
                statusClass = 'unknown';
                updateProgress();
                return;
            }

            if (decision.key === lastSuccessfulKey) {
                statusMessage = `等待下一条 ${successCount}/${targetCount}`;
                statusClass = 'ok';
                updateProgress();
                return;
            }

            const signature = getDecisionSignature(decision);
            const label = decision.action === 'reject' ? '不通过' : '通过';

            if (candidateKey !== signature) {
                candidateKey = signature;
                candidateSince = Date.now();
                statusMessage = `准备${label}，确认中 ${successCount}/${targetCount}`;
                statusClass = 'unknown';
                updateProgress();
                return;
            }

            if (Date.now() - candidateSince < STABLE_MS) {
                return;
            }

            const waitLeft = lastSuccessAt
                ? MIN_INTERVAL_MS - (Date.now() - lastSuccessAt)
                : 0;

            if (waitLeft > 0) {
                statusMessage = `等待 ${Math.ceil(waitLeft / 1000)} 秒 ${successCount}/${targetCount}`;
                statusClass = 'unknown';
                updateProgress();
                return;
            }

            const btn = getReviewButton(decision.action, media.input.ownerDocument);

            if (!btn) {
                pauseAutoReview(`未找到正确的“${label}”按钮`);
                return;
            }

            if (!buttonUsable(btn)) {
                statusMessage = `等待“${label}”按钮 ${successCount}/${targetCount}`;
                statusClass = 'unknown';
                updateProgress();
                return;
            }

            // 对照稳定签名复查记录、审核动作和具体原因
            const finalN = readNumberInfo();
            const finalMedia = readMediaInfo(finalN);
            updateRejectionReason(finalN, finalMedia);
            const finalDecision = getReviewDecision(finalN, finalMedia);

            if (
                getDecisionSignature(finalDecision) !== signature ||
                !finalMedia.input ||
                getReviewButton(finalDecision.action, finalMedia.input.ownerDocument) !== btn
            ) {
                candidateKey = '';
                candidateSince = 0;
                statusMessage = `记录或判断发生变化，重新确认 ${successCount}/${targetCount}`;
                statusClass = 'unknown';
                updateProgress();
                return;
            }

            if (!autoRunning) {
                return;
            }

            let prepared = null;

            if (finalDecision.action === 'reject') {
                prepared = prepareRejectionReason(finalN, finalMedia);

                if (!prepared.ok) {
                    pauseAutoReview(prepared.reason);
                    return;
                }
            }

            // 写入原因后再次核对，避免处理过期的记录或原因
            const clickN = readNumberInfo();
            const clickMedia = readMediaInfo(clickN);
            const clickDecision = getReviewDecision(clickN, clickMedia);

            if (
                !autoRunning ||
                getDecisionSignature(clickDecision) !== signature ||
                clickMedia.input !== finalMedia.input ||
                getReviewButton(clickDecision.action, clickMedia.input.ownerDocument) !== btn ||
                (prepared && clickMedia.input.value !== prepared.text)
            ) {
                candidateKey = '';
                candidateSince = 0;
                return;
            }

            statusMessage = `正在${label}第 ${successCount + 1}/${targetCount} 条`;
            statusClass = 'unknown';
            updateProgress();
            attemptCount++;
            console.warn(`[GISeis V${VERSION}] 点击 #${btn.id}，记录=${decision.key}`);
            const submissionWindow = btn.ownerDocument.defaultView;
            btn.click();

            const result = await verifySubmission(
                decision.key,
                btn,
                decision.action,
                submissionWindow
            );

            if (!result.ok) {
                if (autoRunning) {
                    pauseAutoReview('提交未确认');
                }
                console.error(`[GISeis V${VERSION}] ${result.reason}`);
                return;
            }

            successCount++;

            if (decision.action === 'reject') {
                rejectCount++;
            } else {
                passCount++;
            }

            lastSuccessfulKey = decision.key;
            lastSuccessAt = Date.now();
            candidateKey = '';
            candidateSince = 0;

            // 停止后允许已发出的提交完成确认，不再开始下一次点击
            if (!autoRunning) {
                updateProgress();
                return;
            }

            if (successCount >= targetCount) {
                finishReview();
                return;
            }

            statusMessage = `${label}已确认 ${successCount}/${targetCount}，等待下一条`;
            statusClass = 'ok';
            updateProgress();

        } catch (e) {
            if (autoRunning) {
                pauseAutoReview('审核异常');
            }
            console.error(`[GISeis V${VERSION}] 自动审核异常：`, e);
        } finally {
            busy = false;
        }
    }


    // ============================================================
    // 完成本轮
    // ============================================================

    function finishReview() {

        autoRunning =
            false;


        statusMessage =
            `✓ 已完成 ${successCount}/${targetCount}`;


        statusClass =
            'ok';


        restoreControls();

        updateProgress();


        console.warn(

            `[GISeis V${VERSION}] ` +

            `本轮自动审核完成`
        );
    }


    // ============================================================
    // 页面刷新
    // ============================================================

    function refresh(
        force = false
    ) {

        try {

            clearRejectionReasonOnce();

            createPanel();


            const n =
                readNumberInfo();

            const media = readMediaInfo(n);
            if (!busy) {
                updateRejectionReason(n, media);
            }
            setField(
                'q-media',
                media.status === 'present'
                    ? (media.hasPhoto && media.hasVideo
                        ? '有照片和视频'
                        : (media.hasPhoto ? '有照片' : '有视频'))
                    : (media.status === 'missing'
                        ? MISSING_MEDIA_REASON
                        : (media.status === 'loading' ? '正在加载/确认' : '未找到附件区域')),
                media.status === 'present' ? 'ok'
                    : (media.status === 'missing' ? 'bad' : 'unknown')
            );


            const signature =
                JSON.stringify({

                    line:
                        n.line,

                    calcLine:
                        n.calcLine,

                    point:
                        n.point,

                    calcPoint:
                        n.calcPoint
                });


            if (
                force ||
                signature !==
                    lastSignature
            ) {

                lastSignature =
                    signature;


                updatePanel(n);

            } else {

                updateProgress();
            }


            // ====================================================
            // 调试接口
            // ====================================================

            window.GISeisQC = {

                version:
                    VERSION,

                numbers:
                    n,

                passed:
                    isMatched(n) && media.status === 'present',

                media: {
                    status: media.status,
                    hasPhoto: media.hasPhoto,
                    hasVideo: media.hasVideo
                },

                autoReview: {

                    running:
                        autoRunning,

                    busy,

                    successCount,

                    passCount,

                    rejectCount,

                    attemptCount,

                    targetCount
                },

                start:
                    startReview,

                stop:
                    stopReview,

                refresh:
                    () =>
                        refresh(true)
            };


            // ====================================================
            // 自动审核
            // ====================================================

            tryAutoReview();


        } catch (e) {

            console.error(

                `[GISeis V${VERSION}] ` +
                `刷新错误：`,

                e
            );
        }
    }


    // ============================================================
    // 延迟刷新
    // ============================================================

    function scheduleRefresh(
        delay = 350
    ) {

        clearTimeout(
            refreshTimer
        );


        refreshTimer =
            setTimeout(

                () =>
                    refresh(false),

                delay
            );
    }


    // ============================================================
    // DOM监听
    // ============================================================

    const observer =
        new MutationObserver(
            mutations => {

                for (
                    const mutation
                    of mutations
                ) {

                    try {

                        if (
                            mutation.target.closest &&
                            mutation.target.closest(
                                '#' + PANEL_ID
                            )
                        ) {

                            continue;
                        }

                    } catch (e) {}


                    scheduleRefresh(
                        350
                    );


                    break;
                }
            }
        );


    // ============================================================
    // 页面点击
    // ============================================================

    document.addEventListener(

        'click',

        e => {

            try {

                if (
                    e.target.closest &&
                    (
                        e.target.closest(
                            '#' + PANEL_ID
                        ) ||

                        e.target.closest(
                            '#' + FLOAT_ID
                        )
                    )
                ) {

                    return;
                }

            } catch (e) {}


            scheduleRefresh(
                300
            );


            setTimeout(

                () =>
                    refresh(false),

                1000
            );
        },

        true
    );


    // ============================================================
    // 初始化
    // ============================================================

    function init() {

        createPanel();


        refresh(true);


        observer.observe(

            document.documentElement,

            {

                childList:
                    true,

                subtree:
                    true,

                characterData:
                    true
            }
        );


        // 每500ms检测页面状态
        // 但默认不会自动审核
        // 必须点击“开始审核”

        setInterval(

            () =>
                refresh(false),

            500
        );


        console.log(

            `===== GISeis 测量质检助手 ` +
            `V${VERSION} 初始化完成 =====`
        );
    }


    // ============================================================
    // 启动
    // ============================================================

    if (
        document.readyState ===
        'loading'
    ) {

        document.addEventListener(

            'DOMContentLoaded',

            () =>
                setTimeout(
                    init,
                    800
                )
        );

    } else {

        setTimeout(
            init,
            800
        );
    }

})();
