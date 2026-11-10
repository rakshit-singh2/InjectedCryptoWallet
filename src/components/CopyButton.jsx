import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

const CopyButton = ({ content, testId = 'copy-to-clipboard-button', label = 'Copy' }) => {
  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(content);
      message.success('Copied');
    } catch {
      message.error('Could not copy to the clipboard');
    }
  };
  return (
    <Button
      data-testid={testId}
      aria-label={label}
      onClick={copyToClipboard}
      type="text"
      size="small"
      icon={<CopyOutlined />}
    />
  );
};

export default CopyButton;
