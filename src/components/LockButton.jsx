import { LockFilled } from '@ant-design/icons';
import { Button, Tooltip, message } from 'antd';
import { walletApi } from '../helpers/walletApi';

const LockButton = ({ onLocked }) => {
  const lock = async () => {
    try {
      await walletApi.lock();
      await onLocked?.();
    } catch (error) {
      message.error(error.message);
    }
  };

  return (
    <Tooltip title="Lock wallet">
      <Button data-testid="lock-wallet-button" aria-label="Lock wallet" size="small" shape="circle" onClick={lock} icon={<LockFilled />} />
    </Tooltip>
  );
};

export default LockButton;
