const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};
    
    // Get ALL image sources
    const imgs = document.querySelectorAll('img');
    res.allImages = Array.from(imgs).map(img => ({
      src: img.src,
      alt: img.alt,
      width: img.offsetWidth,
      height: img.offsetHeight,
      visible: img.offsetParent !== null,
    })).filter(i => i.visible);

    // Get Bắt Đầu button inner HTML to see exact icon
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('Bắt Đầu')) {
        res.batDauHTML = btn.innerHTML;
        // Check SVG paths
        const svgs = btn.querySelectorAll('svg');
        res.batDauSVGs = Array.from(svgs).map(svg => ({
          viewBox: svg.getAttribute('viewBox'),
          outerHTML: svg.outerHTML.substring(0, 500),
          pathD: svg.querySelector('path')?.getAttribute('d'),
        }));
        break;
      }
    }

    // Check the attachment area - find the upload illustration
    const allText = document.querySelectorAll('*');
    for (const el of allText) {
      if (el.textContent.includes('Ảnh/Video/File đính kèm') && el.tagName !== 'FORM') {
        const container = el.closest('[class*="dashed"]') || el.closest('[style*="dashed"]') || el.parentElement?.parentElement;
        if (container) {
          const img = container.querySelector('img');
          if (img) {
            res.attachmentImg = {
              src: img.src,
              alt: img.alt,
              width: img.offsetWidth,
              height: img.offsetHeight,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
            };
          }
        }
        break;
      }
    }

    // Get Nhắn tin section textarea rows
    const textareas = document.querySelectorAll('textarea');
    res.textareas = Array.from(textareas).map(t => ({
      rows: t.rows,
      height: t.offsetHeight,
      placeholder: t.placeholder?.substring(0, 50),
    }));

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
