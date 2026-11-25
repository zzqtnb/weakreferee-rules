/**
 * dsh-judge-gate — 客户端半边（侧栏那个入口 + 点开后的容器）。
 *
 * 为什么单独一个文件：闸本体是宿主侧（index.js），只负责判；「点开看一眼」是界面的事，
 * 走宿主侧会把 GUI 代码塞进每次工具调用都要加载的文件里。
 *
 * 面板本体仍然是 tools/panel.cjs 那个本地网页，这里不复制它任何逻辑，只做两件事：
 *   1. 在左侧导航的 面板列表（sidebar.panellist）里放一个图标行，和「插件」「自动化任务」同级；
 *   2. 点开后在主区（main keyed slot）里用 iframe 把那个网页装进来，另给两个按钮
 *      （浏览器打开 / 刷新），iframe 出问题时不至于只剩白屏。
 *
 * 一条纪律：这里不许有业务判断。判据、命中、动作全在 panel.cjs 的 /api/state 里，
 * 改界面不改口径，两边才不会各说一套。
 */
window.__ModuleLoader__.load({
  id: 'dsh-judge-gate',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    // 面板 id：侧栏图标行与主区组件靠它配对，改名要两边一起改
    const PANEL_ID = 'judge-panel';

    // 端口：宿主侧默认起 7788，也能用 localStorage 的 wr-panel-port 指到别处（改过端口的人自己会知道）
    const PORT = (() => {
      try {
        const v = Number(window.localStorage.getItem('wr-panel-port'));
        if (v > 0 && v < 65536) return v;
      } catch (_) { /* 隐私模式读不到就用默认 */ }
      return 7788;
    })();
    const BASE = 'http://127.0.0.1:' + PORT + '/';

    /** 天平图标：一横一竖两个托盘，和「权衡」这件事对得上。 */
    function JudgeIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 3.5v17' }),
        h('path', { d: 'M5 7h14' }),
        h('path', { d: 'M5 7l-2.5 5.5h5L5 7z' }),
        h('path', { d: 'M19 7l-2.5 5.5h5L19 7z' }),
        h('path', { d: 'M8.5 20.5h7' })
      );
    }

    const barStyle = {
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '6px 12px', borderBottom: '1px solid rgba(0,0,0,0.08)',
      font: '12px/1.6 system-ui, "Microsoft YaHei", sans-serif', flex: '0 0 auto',
    };
    const btnStyle = {
      font: 'inherit', cursor: 'pointer', padding: '3px 10px',
      border: '1px solid rgba(0,0,0,0.16)', borderRadius: '6px',
      background: 'transparent', color: 'inherit',
    };

    /** 主区容器：工具栏 + iframe。iframe 里的东西全归 panel.cjs，这里不碰。 */
    function JudgePanel() {
      const frameRef = React.useRef(null);
      const reload = () => {
        const f = frameRef.current;
        if (f) f.src = BASE + '?t=' + Date.now();
      };
      const openOutside = () => {
        try { window.open(BASE, '_blank', 'noopener'); } catch (_) { /* 被弹窗拦截就算了 */ }
      };
      return h(
        'div',
        { style: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: 'var(--dsh-bg, #fff)' } },
        h(
          'div',
          { style: barStyle },
          h('strong', { style: { fontWeight: 600 } }, '判据面板'),
          h('span', { style: { opacity: 0.6 } }, BASE),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { type: 'button', style: btnStyle, onClick: reload }, '刷新'),
          h('button', { type: 'button', style: btnStyle, onClick: openOutside }, '浏览器打开')
        ),
        h('iframe', {
          ref: frameRef,
          title: '弱裁判判据面板',
          src: BASE,
          style: { flex: '1 1 auto', width: '100%', border: '0', display: 'block', minHeight: '0' },
        })
      );
    }

    function apply(ctx) {
      // 侧栏行：和「插件」「自动化任务」同一个列表，order 排它们后面
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '判据' },
          JudgeIcon
        )
      );
      // 主区：keyed slot，key 必须和上面那个 id 一模一样，否则点了没反应
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, JudgePanel)
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.JudgeIcon = JudgeIcon;
    exports.JudgePanel = JudgePanel;
    exports.PANEL_ID = PANEL_ID;
    exports.PANEL_BASE = BASE;
    return module.exports;
  },
});
