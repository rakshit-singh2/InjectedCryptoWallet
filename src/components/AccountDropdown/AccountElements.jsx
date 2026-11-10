import { useEffect, useState } from 'react';
import { UserOutlined, EllipsisOutlined, ExportOutlined } from '@ant-design/icons';
import { Card, Dropdown, Tag } from 'antd';
import { formatAmount, getNativeBalance, shortAddress } from '../../helpers/rpc';

const AccountElements = ({ account, selected, network, onClick, onDetails, 'data-testid': testId }) => {
  const [balance, setBalance] = useState(null);
  const id = account.address.toLowerCase();

  const chainId = network?.chainId;
  const rpcUrl = network?.rpcUrl;
  useEffect(() => {
    let cancelled = false;
    getNativeBalance({ chainId, rpcUrl }, account.address)
      .then((value) => !cancelled && setBalance(value))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [chainId, rpcUrl, account.address]);

  const items = [
    { label: 'Account details', key: 'details', icon: <UserOutlined />, 'data-testid': `account-details-menu-item-${id}` },
    ...(network?.blockExplorerUrl
      ? [{ label: 'View on explorer', key: 'explorer', icon: <ExportOutlined />, 'data-testid': `account-explorer-menu-item-${id}` }]
      : []),
  ];

  const handleMenuClick = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'details') {
      onDetails();
    } else if (key === 'explorer') {
      window.open(`${network.blockExplorerUrl}/address/${account.address}`, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Card
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      size="small"
      hoverable
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      style={{ background: selected ? 'var(--rw-green-light)' : 'white', borderColor: selected ? 'var(--rw-green)' : undefined, color: 'var(--rw-ink)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <UserOutlined style={{ fontSize: 20 }} />
        <div style={{ flex: 1, textAlign: 'left' }}>
          <b>{account.name}</b> {account.type === 'imported' && <Tag>Imported</Tag>}
          <br />
          {shortAddress(account.address)}
        </div>
        <div>{balance === null ? '…' : `${formatAmount(balance, 3)} ${network?.ticker ?? ''}`}</div>
        <Dropdown menu={{ items, onClick: handleMenuClick }} trigger={['click']}>
          <span
            data-testid={`account-actions-${id}`}
            role="button"
            tabIndex={0}
            aria-label={`Actions for ${account.name}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <EllipsisOutlined style={{ fontSize: 18, transform: 'rotate(90deg)' }} />
          </span>
        </Dropdown>
      </div>
    </Card>
  );
};

export default AccountElements;
