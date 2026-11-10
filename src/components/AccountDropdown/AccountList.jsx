import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import AccountElements from './AccountElements';

const AccountList = ({ accounts, selectedAddress, network, onSelect, onDetails, onAdd }) => (
  <>
    <div style={{ maxHeight: 'calc(60vh - 50px)', overflowY: 'auto', display: 'grid', gap: 8 }}>
      {accounts.map((account) => (
        <AccountElements
          key={account.address}
          data-testid={`account-row-${account.address.toLowerCase()}`}
          account={account}
          selected={account.address === selectedAddress}
          network={network}
          onClick={() => onSelect(account.address)}
          onDetails={() => onDetails(account.address)}
        />
      ))}
    </div>
    <Button data-testid="open-add-account-button" style={{ width: '100%', marginTop: 16 }} type="primary" onClick={onAdd}>
      <PlusOutlined /> <b>Add Account</b>
    </Button>
  </>
);

export default AccountList;
