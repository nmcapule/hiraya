declare module 'react' {
  const React: any;
  export default React;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: any[]): T;
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useMemo<T>(factory: () => T, deps: any[]): T;
  export function useRef<T>(initialValue: T): { current: T };
  export function useRef<T>(initialValue: T | null): { current: T | null };
  export function useState<T>(initialValue: T): [T, (value: T | ((current: T) => T)) => void];
}

declare module 'react-dom/client' {
  export function createRoot(element: Element): { render(node: any): void };
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elementName: string]: any;
  }
}
