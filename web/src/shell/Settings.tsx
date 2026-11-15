import type { Quality } from '../world3d';

type QualityOption = 'auto' | 'high' | 'medium' | 'low';

const OPTIONS: Array<{ value: QualityOption; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];

interface Props {
  dusk: boolean;
  onDusk: () => void;
  quality: 'auto' | Quality;
  onQuality: (q: 'auto' | Quality) => void;
}

export function Settings({ dusk, onDusk, quality, onQuality }: Props) {
  return (
    <div>
      <h3>画面</h3>
      <div class="tabs">
        <button type="button" aria-pressed={dusk ? 'true' : 'false'} onClick={onDusk}>
          黄昏
        </button>
      </div>
      <h3>画质</h3>
      <div class="tabs">
        {OPTIONS.map((option) => {
          const disabled = option.value === 'medium';
          return (
            <button
              key={option.value}
              type="button"
              data-quality={option.value}
              class={quality === option.value ? 'on' : undefined}
              disabled={disabled}
              title={disabled ? '下一版本提供' : undefined}
              onClick={() => {
                if (option.value !== 'medium') onQuality(option.value);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
