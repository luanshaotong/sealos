import { pauseAppByName, restartAppByName, startAppByName, uploadApp } from '@/api/app';
import AppStatusTag from '@/components/AppStatusTag';
import GPUItem from '@/components/GPUItem';
import MyIcon from '@/components/Icon';
import { SealosMenu, useMessage } from '@sealos/ui';
import PodLineChart from '@/components/PodLineChart';
import { MyTable } from '@sealos/ui';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { useGlobalStore } from '@/store/global';
import { useUserStore } from '@/store/user';
import { AppListItemType } from '@/types/app';
import { getErrText, getParamValue } from '@/utils/tools';
import { syncConfigMap } from '@/api/configMap'
import {
  Box,
  Button,
  Center,
  Flex,
  Icon,
  Input,
  MenuButton,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  useDisclosure,
  useTheme
} from '@chakra-ui/react';
import { useTranslation } from 'next-i18next';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { ThemeType } from '@sealos/ui';
import { createNamespace } from '@/api/platform';
import FileSelect from '@/components/FileSelect';

const DelModal = dynamic(() => import('@/pages/app/detail/components/DelModal'));

const AppList = ({
  namespaces = [],
  currentNamespace,
  apps = [],
  pagination = { page: 1, pageSize: 10, total: 0, totalPages: 0 },
  currentAppName = '',
  refetchApps
}: {
  apps: AppListItemType[];
  namespaces: string[];
  currentNamespace: string;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  currentAppName: string;
  refetchApps: (namespace: string, page?: number, pageSize?: number, appName?: string) => void;
}) => {
  const { t } = useTranslation();
  const { setLoading } = useGlobalStore();
  const { userSourcePrice } = useUserStore();
  const { message: toast } = useMessage();
  const theme = useTheme<ThemeType>();
  const router = useRouter();
  const currentNamespaceRef = useRef<string>(currentNamespace);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [ns, setNs] = useState('');
  const [searchAppName, setSearchAppName] = useState(currentAppName);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();
  const [isUploading, setIsUploading] = useState(false);

  const [delAppName, setDelAppName] = useState('');
  const { openConfirm: onOpenPause, ConfirmChild: PauseChild } = useConfirm({
    content: '确认停止应用吗？'
  });

  const [files, setFiles] = useState<File[]>([]);
  const { isOpen: isUploadOpen, onOpen: onUploadOpen, onClose: onUploadClose } = useDisclosure();

  // 同步searchAppName与currentAppName
  useEffect(() => {
    setSearchAppName(currentAppName);
  }, [currentAppName]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  const handleRestartApp = useCallback(
    async (appName: string) => {
      try {
        setLoading(true);
        await restartAppByName(currentNamespaceRef.current, appName);
        toast({
          title: `${t('Restart Success')}`,
          status: 'success'
        });
      } catch (error: any) {
        toast({
          title: t(getErrText(error), 'Restart Failed'),
          status: 'error'
        });
        console.error(error, '==');
      }
      setLoading(false);
      refetchApps(currentNamespaceRef.current, pagination?.page || 1, pagination?.pageSize || 10, currentAppName);
    },
    [refetchApps, setLoading, t, toast, pagination?.page, pagination?.pageSize, currentAppName]
  );

  const handlePauseApp = useCallback(
    async (appName: string) => {
      try {
        setLoading(true);
        await pauseAppByName(currentNamespaceRef.current, appName, 'none');
        toast({
          title: t('Application paused'),
          status: 'success'
        });
      } catch (error: any) {
        toast({
          title: t(getErrText(error), 'Pause Failed'),
          status: 'error'
        });
        console.error(error);
      }
      setLoading(false);
      refetchApps(currentNamespaceRef.current, pagination?.page || 1, pagination?.pageSize || 10, currentAppName);
    },
    [refetchApps, setLoading, t, toast, pagination?.page, pagination?.pageSize, currentAppName]
  );

  const handleStartApp = useCallback(
    async (appName: string) => {
      try {
        setLoading(true);
        await startAppByName(currentNamespaceRef.current, appName);
        toast({
          title: t('Start Successful'),
          status: 'success'
        });
      } catch (error: any) {
        toast({
          title: t(getErrText(error), 'Start Failed'),
          status: 'error'
        });
        console.error(error);
      }
      setLoading(false);
      refetchApps(currentNamespaceRef.current, pagination?.page || 1, pagination?.pageSize || 10, currentAppName);
    },
    [refetchApps, setLoading, t, toast, pagination?.page, pagination?.pageSize, currentAppName]
  );

  const setCurrentNamespace = useCallback(
    (namespace: string) => {
      currentNamespaceRef.current = namespace;
      router.push(`/apps?namespace=${namespace}&page=1&pageSize=${pagination?.pageSize || 10}${currentAppName ? `&appName=${encodeURIComponent(currentAppName)}` : ''}`);
      refetchApps(currentNamespaceRef.current, 1, pagination?.pageSize || 10, currentAppName);
    },
    [refetchApps, router, pagination?.pageSize, currentAppName]
  );

  const columns = useMemo<
    {
      title: string;
      dataIndex?: keyof AppListItemType;
      key: string;
      render?: (item: AppListItemType) => JSX.Element;
    }[]
  >(
    () => [
      {
        title: '模型名称',
        key: 'modelName',
        render: (item: AppListItemType) => {
          return (
            <Box pl={4} color={'myGray.900'} fontSize={'md'} fontWeight={'bold'}>
              {item.modelName}
            </Box>
          );
        }
      },
      {
        title: '版本',
        key: 'modelVersion',
        render: (item: AppListItemType) => {
          return (
            <Box pl={4} color={'myGray.900'} fontSize={'md'} fontWeight={'bold'}>
              {item.modelVersion}
            </Box>
          );
        }
      },
      // {
      //   title: '预检链接',
      //   key: 'preInspection',
      //   render: (item: AppListItemType) => {
      //     return (
      //       <Box pl={4} color={'myGray.900'} fontSize={'md'} fontWeight={'bold'}>
      //         {item.preInspection}
      //       </Box>
      //     );
      //   }
      // },
      {
        title: t('Name'),
        key: 'name',
        render: (item: AppListItemType) => {
          return (
            <Box pl={4} color={'myGray.900'} fontSize={'md'} fontWeight={'bold'}>
              {item.name}
            </Box>
          );
        }
      },
      {
        title: t('Status'),
        key: 'status',
        render: (item: AppListItemType) => (
          <AppStatusTag
            status={item.status}
            isStop={item.isStop}
            isPause={item.isPause}
            showBorder={false}
          />
        )
      },

      {
        title: t('Creation Time'),
        dataIndex: 'createTime',
        key: 'createTime'
      },
      {
        title: t('priority'),
        dataIndex: 'priority',
        key: 'priority'
      },
      {
        title: t('CPU'),
        key: 'cpu',
        render: (item: AppListItemType) => (
          <Box h={'35px'} w={['120px', '130px', '140px']}>
            <Box h={'35px'} w={['120px', '130px', '140px']} position={'absolute'}>
              <PodLineChart type="blue" data={item.usedCpu} />
            </Box>
          </Box>
        )
      },
      {
        title: t('Memory'),
        key: 'storage',
        render: (item: AppListItemType) => (
          <Box h={'35px'} w={['120px', '130px', '140px']}>
            <Box h={'35px'} w={['120px', '130px', '140px']} position={'absolute'}>
              <PodLineChart type="purple" data={item.usedMemory} />
            </Box>
          </Box>
        )
      },
      ...(userSourcePrice?.gpu
        ? [
            {
              title: t('GPU'),
              key: 'gpu',
              render: (item: AppListItemType) => <GPUItem gpu={item.gpu} />
            }
          ]
        : []),
      {
        title: t('Replicas'),
        key: 'activeReplicas',
        render: (item: AppListItemType) => (
          <Flex whiteSpace={'nowrap'}>
            <Box color={'myGray.900'}>
              {t('Active')}: {item.activeReplicas}
            </Box>
            {item.minReplicas !== item.maxReplicas && (
              <Box>
                &ensp;/&ensp;{t('Total')}: {item.minReplicas}-{item.maxReplicas}
              </Box>
            )}
          </Flex>
        )
      },
      {
        title: t('Storage'),
        key: 'store',
        render: (item: AppListItemType) => (
          <>{item.storeAmount > 0 ? `${item.storeAmount}Gi` : '-'}</>
        )
      },
      {
        title: t('Operation'),
        key: 'control',
        render: (item: AppListItemType) => (
          <Flex>
            <Button
              variant={'solid'}
              mr={5}
              height={'32px'}
              size={'sm'}
              fontSize={'base'}
              // bg={'grayModern.150'}
              // color={'grayModern.900'}
              // _hover={{
              //   color: 'brightBlue.600'
              // }}
              leftIcon={<MyIcon name={'detail'} w={'16px'} h="16px" />}
              onClick={() =>{
                const showMenu = getParamValue('showMenu')
                if(showMenu){
                  router.push(
                  `/app/detail?namespace=${currentNamespaceRef.current}&&name=${item.name}&showMenu=true`
                )
                }else{
                  router.push(
                  `/app/detail?namespace=${currentNamespaceRef.current}&&name=${item.name}`
                )
                }
              }}
            >
              {t('Details')}
            </Button>
            <SealosMenu
              width={100}
              Button={
                <MenuButton as={Button} variant={'square'} w={'30px'} h={'30px'}>
                  <MyIcon name={'more'} px={3} />
                </MenuButton>
              }
              menuList={[
                ...(item.isPause
                  ? [
                      {
                        child: (
                          <>
                            <MyIcon name={'continue'} w={'16px'} />
                            <Box ml={2} fontWeight={'bold'}>
                              {t('Start Up')}
                            </Box>
                          </>
                        ),
                        onClick: () => handleStartApp(item.name)
                      }
                    ]
                  : [
                      {
                        child: (
                          <>
                            <MyIcon name={'pause'} w={'16px'} />
                            <Box ml={2} fontWeight={'bold'}>
                              停止
                            </Box>
                          </>
                        ),
                        onClick: onOpenPause(() => handlePauseApp(item.name))
                      },
                      {
                        child: (
                          <>
                            <MyIcon name={'change'} w={'16px'} />
                            <Box ml={2} fontWeight={'bold'}>
                              {t('Update')}
                            </Box>
                          </>
                        ),
                        onClick: () => {
                          const showMenu = getParamValue('showMenu')
                          if(showMenu){
                            router.push(
                            `/app/edit?namespace=${currentNamespaceRef.current}&name=${item.name}&showMenu=true`
                          )
                          }else{
                            router.push(
                            `/app/edit?namespace=${currentNamespaceRef.current}&name=${item.name}`
                          )
                          }
                        }
                      },
                      {
                        child: (
                          <>
                            <MyIcon name={'restart'} w="16px" />
                            <Box ml={2} fontWeight={'bold'}>
                              {t('Restart')}
                            </Box>
                          </>
                        ),
                        onClick: () => handleRestartApp(item.name)
                      }
                    ]),

                {
                  child: (
                    <>
                      <MyIcon name={'delete'} w={'16px'} />
                      <Box ml={2} fontWeight={'bold'}>
                        {t('Delete')}
                      </Box>
                    </>
                  ),
                  menuItemStyle: {
                    _hover: {
                      color: 'red.600',
                      bg: 'rgba(17, 24, 36, 0.05)'
                    }
                  },
                  onClick: () => setDelAppName(item.name)
                }
              ]}
            />
          </Flex>
        )
      }
    ],
    [handlePauseApp, handleRestartApp, handleStartApp, onOpenPause, router, t, userSourcePrice?.gpu]
  );

  const validateNamespace = (name: string) => {
    const regex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    return regex.test(name);
  };

  // console.log('namespaces: ****************', namespaces, '***********************');

  return (
    <Box
      backgroundColor={'grayModern.100'}
      px={'32px'}
      pb={5}
      minH={'100%'}
      overflow={'scroll'}
      overflowY={'auto'}
      h={'100%'}
      position={'relative'}
    >
      <Flex h={'88px'} alignItems={'center'}>
        <Center
          w="46px"
          h={'46px'}
          mr={4}
          backgroundColor={'#FEFEFE'}
          border={theme.borders[200]}
          borderRadius={'md'}
        >
          <MyIcon name="logo" w={'24px'} h={'24px'} />
        </Center>
        <Box fontSize={'xl'} color={'grayModern.900'} fontWeight={'bold'}>
          {t('Applications')}
        </Box>
        {/* <LangSelect /> */}
        <Box ml={3} color={'grayModern.500'}>
          ( {apps.length} )
        </Box>
        <Box flex={1}></Box>
        
        {/* App Name Search */}
        <Input
          placeholder={t('按名字搜索') as string}
          value={searchAppName}
          onChange={(e) => {
            const value = e.target.value;
            setSearchAppName(value);
            
            // 清除之前的定时器
            if (searchTimeoutRef.current) {
              clearTimeout(searchTimeoutRef.current);
            }
            
            // 设置新的定时器进行防抖
            searchTimeoutRef.current = setTimeout(() => {
              refetchApps(currentNamespaceRef.current, 1, pagination?.pageSize || 10, value);
            }, 500);
          }}
          w={'200px'}
          mr={4}
          size={'sm'}
        />
        
        <Select
          w={'auto'}
          mr={4}
          value={currentNamespaceRef.current}
          onChange={(e) => setCurrentNamespace(e.target.value)}
        >
          {namespaces.map((namespace: string) => (
            <option key={namespace} value={namespace}>
              {namespace}
            </option>
          ))}
        </Select>

        <Button
          mr={'12px'}
          h={'40px'}
          w={'100px'}
          flex={'0 0 auto'}
          onClick={() => {
            router.push('/imagehub');
          }}
        >
          镜像管理
        </Button>

        {namespaces.length > 1 && (
          <Button mr={'12px'} h={'40px'} w={'100px'} flex={'0 0 auto'} onClick={onOpen}>
            {t('New Namaspace')}
          </Button>
        )}

        <Button
          leftIcon={
            <Icon w="20px" h="20px" fill={'currentcolor'}>
              <path d="M11 19.7908V13.7908H5V11.7908H11V5.79077H13V11.7908H19V13.7908H13V19.7908H11Z" />
            </Icon>
          }
          h={'40px'}
          mr={'14px'}
          minW={'140px'}
          onClick={() => {
            setFiles([]);
            onUploadOpen();
          }}
        >
          {t('upload_file')}
        </Button>

        <Button
          h={'40px'}
          w={'156px'}
          flex={'0 0 auto'}
          leftIcon={<MyIcon name={'plus'} w={'20px'} fill={'#FFF'} />}
          onClick={() => {
             const showMenu = getParamValue('showMenu')
             if(showMenu){
               router.push(`/app/edit?namespace=${currentNamespaceRef.current}&showMenu=true`)
             }else{
               router.push(`/app/edit?namespace=${currentNamespaceRef.current}`)
             }
          }}
        >
          {t('Create Application')}
        </Button>
      </Flex>
      <MyTable itemClass="appItem" columns={columns} data={apps} />
      
      {/* 分页控件 */}
      <Flex justify="space-between" align="center" mt={4} px={4}>
        <Box color={'grayModern.600'} fontSize={'sm'}>
          共 {pagination?.total || 0} 条记录，第 {pagination?.page || 1} 页，共 {pagination?.totalPages || 1} 页
        </Box>
        <Flex align="center" gap={4}>
          <Flex align="center" gap={2}>
            <Box color={'grayModern.600'} fontSize={'sm'}>每页显示：</Box>
            <Select
              w={'auto'}
              size={'sm'}
              value={pagination?.pageSize || 10}
              onChange={(e) => {
                const newPageSize = parseInt(e.target.value);
                refetchApps(currentNamespaceRef.current, 1, newPageSize, currentAppName);
              }}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </Select>
          </Flex>
          <Flex align="center" gap={2}>
            <Button
              size={'sm'}
              variant={'outline'}
              isDisabled={(pagination?.page || 1) === 1}
              onClick={() => refetchApps(currentNamespaceRef.current, (pagination?.page || 1) - 1, pagination?.pageSize || 10, currentAppName)}
            >
              上一页
            </Button>
            <Box color={'grayModern.600'} fontSize={'sm'} px={2}>
              {pagination?.page || 1} / {pagination?.totalPages || 1}
            </Box>
            <Button
              size={'sm'}
              variant={'outline'}
              isDisabled={(pagination?.page || 1) === (pagination?.totalPages || 1)}
              onClick={() => refetchApps(currentNamespaceRef.current, (pagination?.page || 1) + 1, pagination?.pageSize || 10, currentAppName)}
            >
              下一页
            </Button>
          </Flex>
        </Flex>
      </Flex>
      <PauseChild />
      <Modal
        isOpen={isOpen}
        onClose={() => {
          onClose();
          setNs('');
        }}
        closeOnOverlayClick={false}
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{t('New Namaspace')}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Input value={ns} maxLength={10} onChange={(e) => setNs(e.target.value)} />
          </ModalBody>
          <ModalFooter>
            <Button
              width={'64px'}
              onClick={() => {
                onClose();
                setNs('');
              }}
              variant={'outline'}
            >
              {t('Cancel')}
            </Button>
            <Button
              width={'64px'}
              ml={3}
              variant={'solid'}
              onClick={async () => {
                if (!validateNamespace(ns)) {
                  toast({
                    title: '无效的命名空间名称',
                    description:
                      "命名空间名称必须由小写字母、数字或'-'组成，并且必须以字母或数字开头和结尾。",
                    status: 'error',
                    duration: 5000,
                    isClosable: true
                  });
                  return;
                }

                await createNamespace({ ns });
                await syncConfigMap();
                onClose();
                setNs('');
                refetchApps('default', 1, pagination?.pageSize || 10, '');
                toast({
                  title: 'success',
                  status: 'success'
                });
              }}
            >
              {t('Confirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <Modal isOpen={isUploadOpen} onClose={onUploadClose} closeOnOverlayClick={false}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader> {t('upload_file')}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <FileSelect fileExtension=".zip" multiple={false} files={files} setFiles={setFiles} />
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={onUploadClose}>
              取消
            </Button>
            <Button
              isLoading={isUploading}
              isDisabled={isUploading}
              variant="outline"
              onClick={async () => {
                setIsUploading(true);
                try {
                  await uploadApp({
                    appname: 'name',
                    namespace: 'namespace',
                    file: files[0]
                  });
                  toast({
                    status: 'success',
                    title: '上传并部署成功'
                  });
                  onUploadClose();
                } catch (error) {
                  toast({
                    status: 'error',
                    title: 'error'
                  });
                }
                setIsUploading(false);
              }}
            >
              确定
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      {!!delAppName && (
        <DelModal
          namespace={currentNamespaceRef.current}
          appName={delAppName}
          onClose={() => setDelAppName('')}
          onSuccess={() => refetchApps(currentNamespaceRef.current, pagination?.page || 1, pagination?.pageSize || 10, currentAppName)}
        />
      )}
    </Box>
  );
};

export default React.memo(AppList);
