(() => {
  const slot = document.querySelector('.admin-menu-slot');
  if (!slot) return;
  const current = location.pathname;
  const links = [
    ['/admin/catalog', 'Shop-Produkte'],
    ['/admin/buyback', 'Ankauf-Produkte'],
    ['/admin/coupons', 'Coupons'],
    ['/admin/orders', 'Bestellverwaltung'],
    ['/admin/accounting', 'Buchhaltung'],
    ['/admin/audit', 'Audit']
  ];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'admin-menu-toggle';
  button.setAttribute('aria-label', 'Admin-Menü öffnen');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span></span><span></span><span></span>';
  const menu = document.createElement('nav');
  menu.className = 'admin-menu';
  menu.setAttribute('aria-label', 'Admin-Navigation');
  menu.innerHTML = '<p class="menu-title">OLYMP · Shop Admin</p>';
  for (const [href, label] of links) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    if (current === href) link.setAttribute('aria-current', 'page');
    menu.append(link);
  }
  menu.insertAdjacentHTML('beforeend', '<div class="menu-separator"></div>');
  menu.insertAdjacentHTML('beforeend', '<a href="/freie-bestellung.html">Zum öffentlichen Shop</a><a href="/ankauf.html">Zur Ankaufseite</a><a href="/logout">Abmelden</a>');
  const backdrop = document.createElement('div');
  backdrop.className = 'admin-menu-backdrop';
  backdrop.hidden = true;
  document.body.append(button, menu, backdrop);

  const close = () => { menu.classList.remove('open'); backdrop.hidden = true; button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-label', 'Admin-Menü öffnen'); document.body.classList.remove('admin-menu-open'); };
  const open = () => { menu.classList.add('open'); backdrop.hidden = false; button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', 'Admin-Menü schließen'); document.body.classList.add('admin-menu-open'); };
  button.addEventListener('click', () => menu.classList.contains('open') ? close() : open());
  backdrop.addEventListener('click', close);
  menu.addEventListener('click', event => { if (event.target.closest('a')) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
})();
