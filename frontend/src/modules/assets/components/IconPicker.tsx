import { useState, type ComponentType } from 'react';
import { Tooltip } from '@/components/Tooltip';
import {
  Armchair,
  Backpack,
  Bike,
  BookOpen,
  Briefcase,
  Camera,
  Car,
  Coffee,
  Compass,
  Cpu,
  Dumbbell,
  Fan,
  Folder,
  Footprints,
  Gamepad2,
  Gift,
  Glasses,
  HardDrive,
  Headphones,
  Home,
  Keyboard,
  Lamp,
  Laptop,
  Monitor,
  Mouse,
  Music,
  Package,
  PenTool,
  Printer,
  Shirt,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Speaker,
  Tablet,
  Tent,
  Tv,
  Umbrella,
  Watch,
  Wrench,
} from 'lucide-react';

export const ICON_CATALOG: { key: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'package', label: '物品', icon: Package },
  { key: 'smartphone', label: '手机', icon: Smartphone },
  { key: 'laptop', label: '电脑', icon: Laptop },
  { key: 'tablet', label: '平板', icon: Tablet },
  { key: 'monitor', label: '显示器', icon: Monitor },
  { key: 'headphones', label: '耳机', icon: Headphones },
  { key: 'speaker', label: '音箱', icon: Speaker },
  { key: 'camera', label: '相机', icon: Camera },
  { key: 'keyboard', label: '键盘', icon: Keyboard },
  { key: 'mouse', label: '鼠标', icon: Mouse },
  { key: 'hard-drive', label: '存储', icon: HardDrive },
  { key: 'cpu', label: '硬件', icon: Cpu },
  { key: 'printer', label: '打印机', icon: Printer },
  { key: 'tv', label: '电视', icon: Tv },
  { key: 'fan', label: '家电', icon: Fan },
  { key: 'coffee', label: '厨电', icon: Coffee },
  { key: 'lamp', label: '灯具', icon: Lamp },
  { key: 'sparkles', label: '个护', icon: Sparkles },
  { key: 'home', label: '居家', icon: Home },
  { key: 'armchair', label: '家具', icon: Armchair },
  { key: 'wrench', label: '工具', icon: Wrench },
  { key: 'pen-tool', label: '文具', icon: PenTool },
  { key: 'shirt', label: '服装', icon: Shirt },
  { key: 'footprints', label: '鞋靴', icon: Footprints },
  { key: 'briefcase', label: '箱包', icon: Briefcase },
  { key: 'backpack', label: '背包', icon: Backpack },
  { key: 'shopping-bag', label: '购物袋', icon: ShoppingBag },
  { key: 'watch', label: '手表', icon: Watch },
  { key: 'glasses', label: '眼镜', icon: Glasses },
  { key: 'umbrella', label: '雨具', icon: Umbrella },
  { key: 'dumbbell', label: '健身', icon: Dumbbell },
  { key: 'bike', label: '骑行', icon: Bike },
  { key: 'tent', label: '露营', icon: Tent },
  { key: 'car', label: '车辆', icon: Car },
  { key: 'compass', label: '出行', icon: Compass },
  { key: 'gamepad-2', label: '游戏', icon: Gamepad2 },
  { key: 'music', label: '乐器', icon: Music },
  { key: 'book-open', label: '图书', icon: BookOpen },
  { key: 'gift', label: '礼物', icon: Gift },
  { key: 'folder', label: '文件夹', icon: Folder },
];

const ICON_MAP = new Map(ICON_CATALOG.map((item) => [item.key, item.icon]));

export function AssetIcon({ name, className = 'h-4 w-4' }: { name?: string; className?: string }) {
  const key = (name || 'package').trim();
  const Comp = ICON_MAP.get(key);
  if (Comp) {
    return <Comp className={className} />;
  }
  // Support arbitrary emoji or short symbol fallback
  if (key && !/^[a-z0-9-]+$/i.test(key)) {
    return <span className="leading-none text-base">{key}</span>;
  }
  return <Package className={className} />;
}

export function AssetVisual({
  icon,
  imageUrl,
  name,
  size = 'md',
}: {
  icon?: string;
  imageUrl?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [imgErr, setImgErr] = useState(false);
  const boxClass =
    size === 'sm'
      ? 'h-8 w-8 rounded-lg'
      : size === 'lg'
        ? 'h-14 w-14 rounded-xl'
        : 'h-10 w-10 rounded-xl';
  const iconClass = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-6 w-6' : 'h-5 w-5';

  if (imageUrl && !imgErr) {
    return (
      <img
        src={imageUrl}
        alt={name}
        onError={() => setImgErr(true)}
        className={`${boxClass} shrink-0 border border-zinc-200/70 bg-zinc-50 object-cover`}
      />
    );
  }
  return (
    <div
      className={`${boxClass} flex shrink-0 items-center justify-center border border-sky-100 bg-sky-50/70 text-sky-600`}
    >
      <AssetIcon name={icon} className={iconClass} />
    </div>
  );
}

export function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [customEmoji, setCustomEmoji] = useState('');

  return (
    <div className="space-y-2">
      <div className="grid max-h-40 grid-cols-6 sm:grid-cols-8 gap-1 overflow-y-auto rounded-lg border border-zinc-200/80 bg-[#f8fafc] p-2">
        {ICON_CATALOG.map(({ key, label, icon: Icon }) => {
          const active = value === key;
          return (
            <Tooltip key={key} content={label} delay={120}>
              <button
                type="button"
                onClick={() => onChange(key)}
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  active
                    ? 'bg-sky-500 text-white shadow-xs'
                    : 'text-zinc-500 hover:bg-white hover:text-zinc-800'
                }`}
              >
                <Icon className="h-4 w-4" />
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={customEmoji}
          onChange={(e) => setCustomEmoji(e.target.value)}
          placeholder="或输入自定义 Emoji（如 📷）"
          className="yd-input-sm flex-1"
          maxLength={8}
        />
        <button
          type="button"
          disabled={!customEmoji.trim()}
          onClick={() => {
            onChange(customEmoji.trim());
            setCustomEmoji('');
          }}
          className="yd-btn-secondary text-xs"
        >
          使用
        </button>
      </div>
    </div>
  );
}
