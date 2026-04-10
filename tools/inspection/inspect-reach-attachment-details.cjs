const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};

    // 1. Attachment illustration src
    const imgs = document.querySelectorAll('img');
    imgs.forEach(img => {
      const src = img.src || '';
      if (src.includes('illustration') || src.includes('upload') || src.includes('attach')) {
        res['img_' + (img.alt || 'noalt')] = { src, width: img.offsetWidth, height: img.offsetHeight };
      }
    });

    // 2. Cách nhau layout - find the container
    const allText = document.querySelectorAll('*');
    for (const el of allText) {
      if (el.textContent.trim() === 'Cách nhau:' && el.children.length === 0) {
        const parent = el.parentElement;
        res.cachNhauParent = {
          display: getComputedStyle(parent).display,
          flexDirection: getComputedStyle(parent).flexDirection,
          gap: getComputedStyle(parent).gap,
          outerHTML: parent.outerHTML.substring(0, 500),
        };
        // Get the container with inputs
        const grandparent = parent.parentElement;
        res.cachNhauGrandparent = {
          display: getComputedStyle(grandparent).display,
          flexDirection: getComputedStyle(grandparent).flexDirection,
          gap: getComputedStyle(grandparent).gap,
          alignItems: getComputedStyle(grandparent).alignItems,
          outerHTML: grandparent.outerHTML.substring(0, 800),
        };
        break;
      }
    }

    // 3. Bắt Đầu button details
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('Bắt Đầu')) {
        const cs = getComputedStyle(btn);
        res.batDauBtn = {
          width: btn.offsetWidth,
          height: btn.offsetHeight,
          borderRadius: cs.borderRadius,
          bgColor: cs.backgroundColor,
          innerText: btn.innerText,
          innerHTML: btn.innerHTML.substring(0, 500),
        };
        // Check siblings
        const parent = btn.parentElement;
        res.batDauParent = {
          display: getComputedStyle(parent).display,
          flexDirection: getComputedStyle(parent).flexDirection,
          gap: getComputedStyle(parent).gap,
          children: Array.from(parent.children).map(c => ({
            tag: c.tagName,
            text: c.textContent.substring(0, 50),
            display: getComputedStyle(c).display,
          })),
        };
        break;
      }
    }

    // 4. Tab labels in right column
    const tabs = document.querySelectorAll('[role="tab"]');
    res.tabs = Array.from(tabs).map(t => ({
      label: t.textContent.trim(),
      fontSize: getComputedStyle(t).fontSize,
      minWidth: getComputedStyle(t).minWidth,
      width: t.offsetWidth,
      height: t.offsetHeight,
    }));

    // 5. Từ (giây) / Đến (giây) inputs layout
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      if (inp.value === '60') {
        const label = inp.closest('.MuiFormControl-root')?.querySelector('label');
        if (label && label.textContent.includes('Từ')) {
          const field = inp.closest('.MuiFormControl-root');
          const fieldParent = field.parentElement;
          res.delayFieldsParent = {
            display: getComputedStyle(fieldParent).display,
            flexDirection: getComputedStyle(fieldParent).flexDirection,
            gap: getComputedStyle(fieldParent).gap,
            outerHTML: fieldParent.outerHTML.substring(0, 500),
          };
        }
      }
    }

    // 6. Get the bottom row layout (cách nhau + spam + bắt đầu + soon)
    // Find the parent that contains all these
    for (const el of allText) {
      if (el.textContent.trim() === 'Spam' && el.children.length === 0) {
        let container = el.parentElement;
        // Walk up to find the flex row
        for (let i = 0; i < 5; i++) {
          const cs = getComputedStyle(container);
          if (cs.display === 'flex' && container.children.length >= 3) {
            res.bottomRow = {
              display: cs.display,
              flexDirection: cs.flexDirection,
              flexWrap: cs.flexWrap,
              gap: cs.gap,
              alignItems: cs.alignItems,
              children: Array.from(container.children).map(c => ({
                tag: c.tagName,
                text: c.textContent.substring(0, 60),
                width: c.offsetWidth,
                display: getComputedStyle(c).display,
                flexDirection: getComputedStyle(c).flexDirection,
              })),
            };
            break;
          }
          container = container.parentElement;
        }
        break;
      }
    }

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
