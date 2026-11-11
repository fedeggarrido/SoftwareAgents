import type { ButtonHTMLAttributes } from 'react';

const sizes = {
  sm: 'px-8',
  md: 'px-12',
  lg: 'px-14',
  xl: 'px-24',
  icon: 'p-0 w-44 flex items-center justify-center',
  icon_lg: 'p-0 w-44 flex items-center justify-center',
} as const;
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: keyof typeof sizes;
}
export function Button({
  variant = 'secondary',
  size = 'lg',
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`pixel-button pixel-button-${variant} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
