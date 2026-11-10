import { useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { LinkOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import AccountDropdown from '../AccountDropdown/AccountDropdown';
import WalletViewContent from './WalletViewContent';
import CopyButton from '../CopyButton';
import ChainSelector from '../ChainSelector/ChainSelector';
import LockButton from '../LockButton';
import RunningBatches from './RunningBatches';
import { formatAmount, getNativeBalance } from '../../helpers/rpc';


const WalletView = ({ state, refresh }) => {
  const navigate = useNavigate();
  const network = state.networks[state.selectedChainId];
  const account = state.accounts.find((a) => a.address === state.selectedAddress) || state.accounts[0];
  const [balance, setBalance] = useState(null);
  const [balanceError, setBalanceError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const chainId = network?.chainId;
  const rpcUrl = network?.rpcUrl;
  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setBalanceError(false);
    getNativeBalance({ chainId, rpcUrl }, account?.address)
      .then((value) => !cancelled && setBalance(value))
      .catch(() => !cancelled && setBalanceError(true));
    return () => {
      cancelled = true;
    };
  }, [chainId, rpcUrl, account?.address, reloadKey]);

  if (!account || !network) {
    return null;
  }

  return (
    <>
      <div className="wallet-header">
        <ChainSelector state={state} refresh={refresh} />
        <div style={{ display: 'flex', alignItems: 'center', flexDirection: 'column' }}>
          <div className="accountName">{account.name}</div>
          <div className="wallet-account-row">
            <AccountDropdown state={state} refresh={refresh} network={network} />
            <CopyButton content={account.address} testId="copy-wallet-address-button" label="Copy address" />
          </div>
        </div>
        <div className="wallet-header-actions">
          <Tooltip title="Connected sites">
            <Button data-testid="connected-sites-button" aria-label="Connected sites" size="small" shape="circle" icon={<LinkOutlined />} onClick={() => navigate('/connections')} />
          </Tooltip>
          <Tooltip title="Settings">
            <Button data-testid="settings-button" aria-label="Settings" size="small" shape="circle" icon={<SettingOutlined />} onClick={() => navigate('/settings')} />
          </Tooltip>
          <LockButton onLocked={refresh} />
        </div>
      </div>
      <RunningBatches />
      <div className="balance-container">
        <div className="balance-label">Total balance</div>
        <div className="balance" data-testid="wallet-balance">
          {balanceError ? 'Unavailable' : balance === null ? '…' : `${formatAmount(balance)} ${network.ticker}`}
        </div>
        <div className="balance-network">{network.name}</div>
      </div>
      <WalletViewContent
        account={account}
        network={network}
        onTransactionSent={() => setReloadKey((key) => key + 1)}
      />
    </>
  );
};

export default WalletView;
