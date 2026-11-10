import { createContext, useContext } from 'react';

export const OfficeRecoveryContext = createContext({
  openSettings: () => {},
  prepareProject: () => {},
});
export const useOfficeRecovery = () => useContext(OfficeRecoveryContext);
