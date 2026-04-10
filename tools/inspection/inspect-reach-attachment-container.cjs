const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};
    
    // Find "Ảnh/Video/File đính kèm" text node, then go up to get the container
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode;
    while (textNode = walker.nextNode()) {
      if (textNode.textContent.includes('Ảnh/Video/File đính kèm')) {
        const container = textNode.parentElement.closest('div[class]')?.parentElement?.parentElement || textNode.parentElement.parentElement;
        res.attachContainer = {
          innerHTML: container.innerHTML.substring(0, 3000),
          borderStyle: getComputedStyle(container).borderStyle,
          width: container.offsetWidth,
          height: container.offsetHeight,
        };
        // Check for img/svg inside the container
        const allImgs = container.querySelectorAll('img');
        res.attachImgs = Array.from(allImgs).map(i => ({
          src: i.src,
          alt: i.alt,
          width: i.naturalWidth,
          height: i.naturalHeight,
        }));
        // Check inline SVGs
        const allSvgs = container.querySelectorAll('svg');
        res.attachSvgs = allSvgs.length;
        // Check data-src or background images
        const allChildren = container.querySelectorAll('*');
        for (const child of allChildren) {
          const bg = getComputedStyle(child).backgroundImage;
          if (bg && bg !== 'none') {
            res.bgImage = bg.substring(0, 500);
          }
        }
        // Look at MuiBox with illustration
        const boxes = container.querySelectorAll('[class*="MuiBox"]');
        for (const box of boxes) {
          if (box.style.backgroundImage || box.querySelector('img')) {
            res.boxWithImage = {
              bgImage: box.style.backgroundImage,
              innerHTML: box.innerHTML.substring(0, 500),
            };
          }
        }
        break;
      }
    }

    // Also check for any illustration images in the left column area
    const form = document.querySelector('form');
    if (form) {
      const formImgs = form.querySelectorAll('img');
      res.formImages = Array.from(formImgs).map(i => ({
        src: i.src,
        alt: i.alt,
        width: i.offsetWidth,
        height: i.offsetHeight,
        visible: i.offsetParent !== null,
      }));
    }

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
