import { networkInterfaces } from 'os';
import { execSync } from 'child_process';

/**
 * Получает все IP-адреса машины (IPv4)
 */
export function getLocalIPs(): string[] {
  const interfaces = networkInterfaces();
  const ips: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;

    for (const info of netInterface) {
      // Пропускаем internal и IPv6
      if (info.internal || info.family === 'IPv6') continue;
      // Пропускаем link-local
      if (info.address.startsWith('169.254.')) continue;
      // Пропускаем виртуальные/Docker сети (10.0.x.x, 172.16-31.x.x, 192.168.x.x - обычные, но не 10.20.x.x часто виртуальные)
      // Оставляем только типичные локальные сети
      if (info.address.startsWith('10.') && !info.address.startsWith('10.0.') && !info.address.startsWith('10.1.')) continue;
      if (info.address.startsWith('172.1') || info.address.startsWith('172.2')) continue;

      ips.push(info.address);
    }
  }

  return ips;
}

/**
 * Получает Yggdrasil IPv6 адрес (200:/300: диапазон)
 * Это fallback-адрес на случай падения IPv4
 */
export function getYggdrasilAddress(): string | null {
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;

    for (const info of netInterface) {
      if (info.family !== 'IPv6') continue;
      // Yggdrasil адреса в диапазоне 200::/7 (от 200:: до 3ff::)
      if (/^[23][0-9a-f]{2}:/i.test(info.address)) {
        return info.address;
      }
    }
  }

  return null;
}

/**
 * Получает информацию о Yggdrasil (адрес, подсеть, публичный ключ)
 * Использует yggdrasilctl если доступен
 */
export function getYggdrasilInfo(): {
  address: string | null;
  subnet: string | null;
  publicKey: string | null;
  peers: number;
  running: boolean;
} {
  const result = {
    address: getYggdrasilAddress(),
    subnet: null as string | null,
    publicKey: null as string | null,
    peers: 0,
    running: false,
  };

  // Если нашли адрес через интерфейсы — сервис работает
  if (result.address) {
    result.running = true;
  }

  // Пробуем получить полную инфу через yggdrasilctl
  try {
    const yggctlPath = process.platform === 'win32'
      ? '"C:\\Program Files\\Yggdrasil\\yggdrasilctl.exe"'
      : 'yggdrasilctl';

    const selfOutput = execSync(`${yggctlPath} getSelf`, {
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Парсим IPv6 address
    const addrMatch = selfOutput.match(/IPv6 address:\s*│?\s*([0-9a-f:]+)/i);
    if (addrMatch) result.address = addrMatch[1].trim();

    // Парсим IPv6 subnet
    const subnetMatch = selfOutput.match(/IPv6 subnet:\s*│?\s*([0-9a-f:/]+)/i);
    if (subnetMatch) result.subnet = subnetMatch[1].trim();

    // Парсим Public key
    const keyMatch = selfOutput.match(/Public key:\s*│?\s*([0-9a-f]+)/i);
    if (keyMatch) result.publicKey = keyMatch[1].trim();

    result.running = true;

    // Считаем пиров
    try {
      const peersOutput = execSync(`${yggctlPath} getPeers`, {
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Считаем строки с "Up" (активные пиры)
      const upPeers = (peersOutput.match(/│\s*Up\s*│/g) || []).length;
      result.peers = upPeers;
    } catch {
      // getPeers может не работать
    }
  } catch {
    // yggdrasilctl не доступен — используем только данные из интерфейсов
  }

  return result;
}

/**
 * Получает основной (публичный) IP-адрес машины
 * Предпочитает типичные локальные IP (192.168.x.x, 10.0.x.x)
 * Yggdrasil IPv6 НЕ используется как основной — только fallback
 */
export function getPrimaryIP(): string | null {
  const interfaces = networkInterfaces();
  
  // Приоритетные диапазоны (в порядке предпочтения)
  const priorityRanges = [
    '192.168.',   // Домашние/офисные сети
    '10.0.',      // Частные сети
    '10.1.',      // Частные сети
  ];

  for (const name of Object.keys(interfaces)) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;

    for (const info of netInterface) {
      // Пропускаем internal и IPv6
      if (info.internal || info.family === 'IPv6') continue;
      // Пропускаем link-local
      if (info.address.startsWith('169.254.')) continue;

      // Проверяем приоритетные диапазоны
      for (const range of priorityRanges) {
        if (info.address.startsWith(range)) {
          return info.address;
        }
      }
    }
  }

  // Если не нашли приоритетные, возвращаем первый подходящий IPv4
  const allIPs = getLocalIPs();
  return allIPs.length > 0 ? allIPs[0] : null;
}

/**
 * Форматирует IP-адреса для отображения (включая Yggdrasil fallback)
 */
export function formatIPsForDisplay(): string {
  const ips = getLocalIPs();
  const yggAddr = getYggdrasilAddress();
  
  if (ips.length === 0 && !yggAddr) return 'No IP found';
  
  let result = ips.slice(0, 3).join(', ');
  if (ips.length > 3) result += ` (+${ips.length - 3} more)`;
  
  if (yggAddr) {
    result += (result ? ' | ' : '') + `Ygg: ${yggAddr}`;
  }
  
  return result;
}
