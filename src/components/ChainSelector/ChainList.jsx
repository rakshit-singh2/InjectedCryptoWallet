import { Button, List, Popconfirm, Typography } from 'antd';
import { EditTwoTone, DeleteTwoTone, PlusOutlined } from '@ant-design/icons';
import { networkIcon } from '../../helpers/rpc';

const ChainList = ({ networks, selectedChainId, onSelect, onEdit, onRemove, onAdd }) => (
  <>
    <List
      dataSource={networks}
      style={{ maxHeight: 'calc(60vh - 50px)', overflowY: 'auto' }}
      renderItem={(network) => (
        <List.Item
          key={network.chainId}
          data-testid={`chain-option-${network.chainId}`}
          role="button"
          tabIndex={0}
          aria-pressed={network.chainId === selectedChainId}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(network.chainId);
            }
          }}
          onClick={() => onSelect(network.chainId)}
          style={{
            cursor: 'pointer',
            border: '1px solid #d9d9d9',
            borderRadius: 4,
            background: network.chainId === selectedChainId ? '#f0e9ff' : '#ffffff',
            marginBottom: 8,
            padding: 10,
          }}
        >
          <Typography.Text>
            <img src={networkIcon(network)} alt="" style={{ width: 20, marginRight: 8 }} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            {network.name}
          </Typography.Text>
          {!network.builtIn && (
            <div style={{ display: 'flex' }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Button data-testid={`edit-chain-${network.chainId}`} aria-label={`Edit ${network.name}`} type="text" icon={<EditTwoTone />} onClick={() => onEdit(network)} />
              <Popconfirm
                title={`Remove ${network.name}?`}
                onConfirm={() => onRemove(network)}
                okButtonProps={{ 'data-testid': `confirm-delete-chain-${network.chainId}` }}
                cancelButtonProps={{ 'data-testid': `cancel-delete-chain-${network.chainId}` }}
              >
                <Button data-testid={`delete-chain-${network.chainId}`} aria-label={`Remove ${network.name}`} type="text" icon={<DeleteTwoTone />} />
              </Popconfirm>
            </div>
          )}
        </List.Item>
      )}
    />
    <Button data-testid="open-add-chain-button" style={{ width: '100%', marginTop: 16 }} type="primary" onClick={onAdd}>
      <PlusOutlined /> <b>Add Network</b>
    </Button>
  </>
);

export default ChainList;
