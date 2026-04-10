const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};

    // 1. Sidebar details
    const sidebar = document.querySelector('nav') || document.querySelector('[class*="drawer"]') || document.querySelector('[class*="Drawer"]');
    if (sidebar) {
      res.sidebar = {
        width: sidebar.offsetWidth,
        bgColor: getComputedStyle(sidebar).backgroundColor,
      };
    }

    // 2. Get exact App bar / header details
    const appbar = document.querySelector('header');
    if (appbar) {
      const cs = getComputedStyle(appbar);
      res.header = {
        height: appbar.offsetHeight,
        bgColor: cs.backgroundColor,
        borderBottom: cs.borderBottom,
        position: cs.position,
        left: cs.left,
        right: cs.right,
      };
    }

    // 3. Main content area
    const main = document.querySelector('main') || document.querySelector('[role="main"]');
    if (main) {
      res.main = {
        paddingTop: getComputedStyle(main).paddingTop,
        paddingLeft: getComputedStyle(main).paddingLeft,
        paddingRight: getComputedStyle(main).paddingRight,
      };
    }

    // 4. Left column card/container - check if it has a Card/Paper wrapper
    const form = document.querySelector('form');
    if (form) {
      const cs = getComputedStyle(form);
      res.form = {
        padding: cs.padding,
        bgColor: cs.backgroundColor,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow,
        border: cs.border,
      };
      const parent = form.parentElement;
      const pcs = getComputedStyle(parent);
      res.formParent = {
        padding: pcs.padding,
        display: pcs.display,
        flexDirection: pcs.flexDirection,
        gap: pcs.gap,
      };
    }

    // 5. Right column container  
    const allText = document.querySelectorAll('*');
    for (const el of allText) {
      if (el.textContent.trim() === 'Bộ sưu tập:' && el.children.length === 0) {
        const container = el.closest('[class*="MuiGrid"]') || el.closest('[class*="MuiPaper"]') || el.parentElement?.parentElement;
        if (container) {
          const cs = getComputedStyle(container);
          res.rightColumn = {
            padding: cs.padding,
            bgColor: cs.backgroundColor,
            border: cs.border,
            borderRadius: cs.borderRadius,
          };
        }
        break;
      }
    }

    // 6. Body/page background
    res.bodyBg = getComputedStyle(document.body).backgroundColor;
    
    // 7. Check if left and right columns are within a Card component
    for (const el of allText) {
      if (el.textContent.trim() === 'Tài khoản:' && el.children.length === 0) {
        let container = el.parentElement;
        for (let i = 0; i < 10; i++) {
          const cs = getComputedStyle(container);
          if (cs.boxShadow !== 'none' || cs.border !== '0px none rgb(33, 43, 54)') {
            res.leftColumnContainer = {
              tag: container.tagName,
              className: container.className.substring(0, 100),
              boxShadow: cs.boxShadow?.substring(0, 100),
              border: cs.border,
              borderRadius: cs.borderRadius,
              padding: cs.padding,
              bgColor: cs.backgroundColor,
            };
            break;
          }
          container = container.parentElement;
          if (!container) break;
        }
        break;
      }
    }

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
