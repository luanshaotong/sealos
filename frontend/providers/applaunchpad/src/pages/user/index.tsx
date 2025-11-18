import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteImageHub, deleteResourceQuotas, getResourceQuotas, updateResourceQuotas, uploadImageHub } from '@/api/app';
import FileSelect from '@/components/FileSelect';
import MyIcon from '@/components/Icon';
import { ImageHubItem } from '@/pages/api/imagehub/get';
import { formatPodTime } from '@/utils/tools';
import { getRoles } from '@/api/roles'
import {
  Box,
  Button,
  Center,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  HStack,
  Icon,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  useDisclosure,
  useTheme,
  Table,
  Thead,
  Tbody,
  Tfoot,
  Tr,
  Th,
  Td,
  TableCaption,
  TableContainer,
  Select,
  useToast,
  InputGroup,
  InputRightAddon
} from '@chakra-ui/react';
import type { ThemeType } from '@sealos/ui';
import { useMessage } from '@sealos/ui';
import dayjs from 'dayjs';
import { debounce } from 'lodash';
import { useTranslation } from 'next-i18next';
import { useRouter } from 'next/router';
import { syncConfigMap } from '@/api/configMap'
import { createNamespace } from '@/api/platform';
import { useForm } from 'react-hook-form';

const AppList = ({
  apps = [],
  namespaces,
  refetchApps,
  onSearch
}: {
  namespaces: string[];
  apps: ImageHubItem[];
  refetchApps: () => void;
  onSearch: (value: string) => void;
}) => {
  const [userDataList, setUserDataList] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [currentData, setCurrentData] = useState<any>(null)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [roleId, setRoleId] = useState<any>(null)
  const toast = useToast();
  const {
    register,
    control,
    setValue,
    getValues,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<any>()
  const columns = [
    { title: '用户名', field: 'username' },
    { title: '命名空间', field: 'namespace' },
    { title: '创建时间', field: 'createtime', render: (row: any) => dayjs(row.createtime).format('YYYY-MM-DD HH:mm:ss') },
    { title: 'cpu', field: 'cpu' },
    { title: '内存', field: 'memory' },
    { title: '磁盘数量', field: 'persistentvolumeclaims' },
    { title: '网络服务数量', field: 'services' },
    { title: '存储', field: 'storage' },
    { title: '操作' }
  ];
  const [roles, setRoles] = useState<any[]>([])

  const Label = ({
    children,
    w = 200,
    ...props
  }: {
    children: string;
    w?: number | 'auto';
    [key: string]: any;
  }) => (
    <Box
      flex={`0 0 ${w === 'auto' ? 'auto' : `${w}px`}`}
      color={'grayModern.900'}
      fontWeight={'bold'}
      userSelect={'none'}
      {...props}
    >
      {children}
    </Box>
  );

  useEffect(() => {
    initUserDataAndResource()
    fetchRoleList()
  }, [])

  const initUserDataAndResource = async () => {
    const resp = await getResourceQuotas()
    if (resp) {
      setUserDataList(resp)
    }
  }

  const onOpen = () => {
    setIsOpen(true)
  }

  const onClose = () => {
    setIsOpen(false)
  }
  const fetchRoleList = async () => {
    const res = await getRoles({})
    setRoles(res)
  }

  const onConfirm = async () => {
    try {
      const resp = await createNamespace({
        ns: username,
        roleId: roleId
      })
      if (resp) {
        await syncConfigMap()
        toast({
          status: 'success',
          title: '创建成功'
        })
        onClose()
        initUserDataAndResource()
      }
    } catch (error: any) {
      return toast({
        status: 'error',
        title: error.message
      });
    }
  }

  const onEdit = async (data: any) => {
    const formData = {
      namespace: data.namespace,
      username: data.username,
      roleId: data.roleId,
      services: Number(data.services),
      requestsStorage: Number(data.storage.split('Gi')[0]),
      persistentVolumeClaims: Number(data.persistentvolumeclaims),
      limitsCpu: Number(data.cpu),
      limitsMemory: Number(data.memory.split('Gi')[0]),
    }
    setCurrentData(formData)
    setRoleId(data.roleId)
    // 使用 reset 方法将数据同步到表单
    reset(formData)
    setIsEditOpen(true)
  }

  const onDelete = async (data: any) => {
    setCurrentData(data)
    setIsDeleteOpen(true)
  }

  const onDeleteClose = () => {
    setCurrentData(null)
    setIsDeleteOpen(false)
  }

  const onDeleteConfirm = async () => {
    try {
      if (currentData) {
        const resp = await deleteResourceQuotas(currentData.namespace)
        if (resp) {
          toast({
            status: 'success',
            title: '删除成功'
          })
          onDeleteClose()
          initUserDataAndResource()
        }
      }
    } catch (error) {
    }
  }

  const onEditClose = () => {
    setCurrentData(null)
    setIsEditOpen(false)
  }

  const onEditConfirm = async (data: any) => {
    try {
      console.log('提交的表单数据:', data);
      console.log('currentData:', currentData);
      
      const resp = await updateResourceQuotas(currentData.namespace, {
        namespace: currentData.namespace,
        username: data.username,
        roleId: data.roleId,
        limits: {
          services: data.services,
          requestsStorage: `${data.requestsStorage}Gi`,
          persistentVolumeClaims: data.persistentVolumeClaims,
          limitsCpu: `${data.limitsCpu}`,
          limitsMemory: `${data.limitsMemory}Gi`
        }
      })
      if (resp) {
        toast({
          status: 'success',
          title: '编辑成功'
        })
        onEditClose()
        initUserDataAndResource()
      }
    } catch (error: any) {
      console.error('编辑失败:', error);
      toast({
        status: 'error',
        title: error?.message || '编辑失败'
      })
    }
  }

  return (
    <Box backgroundColor={'grayModern.100'} px={'32px'} pb={5} minH={'100%'}>
      <Flex h={'88px'} alignItems={'center'} justifyContent={'space-between'}>
        <Flex alignItems={'center'}>
          <Center
            w="46px"
            h={'46px'}
            mr={4}
            backgroundColor={'#FEFEFE'}
            borderRadius={'md'}
          >
            <MyIcon name="logo" w={'24px'} h={'24px'} />
          </Center>
          <Box fontSize={'xl'} color={'grayModern.900'} fontWeight={'bold'}>
            用户管理
          </Box>
        </Flex>
        <Button onClick={onOpen}>创建用户</Button>
      </Flex>

      <TableContainer>
        <Table variant="simple" backgroundColor={'white'} color={'black'}>
          <Thead>
            <Tr>
              {columns.map((column, index) => (
                <Th key={index}>{column.title}</Th>
              ))}
            </Tr>
          </Thead>
          <Tbody>
            {userDataList.map((row, rowIndex) => (
              <Tr key={rowIndex}>
                {columns.map((column, colIndex) => (
                  column.title === '操作' ?
                    <Td key={`${rowIndex}-${colIndex}`}>
                      <Flex gap={'1'}>
                        <Button size="sm" onClick={() => { onEdit(row) }}>编辑</Button>
                        <Button bgColor={'red'} colorScheme='red' _hover={{ bgColor: 'red' }} size="sm" onClick={() => { onDelete(row) }}>删除</Button>
                      </Flex>
                    </Td> :
                    <Td key={`${rowIndex}-${colIndex}`}>
                      {column.render ? column.render(row) : row[column.field as keyof typeof row]}
                    </Td>
                ))}
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>

      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>新增用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'center'} mb={5}>
                <Label>用户名</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  width={300}
                  style={{borderColor:errors.username ? 'red' : '#02A7F0'}}
                  
                  // {...register(`username`, {
                  //   required: '请输入'
                  // })}
                  autoFocus={true}
                  maxLength={20}
                />
              </Flex>
            </FormControl>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'center'} mb={5}>
                <Label>角色</Label>
                <Select
                  style={{borderColor: '#02A7F0'}}
                  width={300}
                  mr={4}
                  value={roleId}
                  onChange={(e) => {
                    setRoleId(e.target.value)
                  }}
                >
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </Flex>
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={onConfirm}>
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>删除用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <p>确定删除吗？</p>
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={onDeleteConfirm}>
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isEditOpen} onClose={onEditClose} size={'4xl'} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>编辑用户</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <FormControl mb={7} w={'100%'}>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>用户名</Label>
                <Box flex={1}>
                  <Input
                    type='text'
                    style={{borderColor:errors.username ? 'red' : '#02A7F0'}}
                    {...register(`username`, {
                      required: '请输入用户名'
                    })}
                    autoFocus={true}
                    maxLength={20}
                  />
                  {errors.username && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.username.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>角色</Label>
                <Box flex={1}>
                  <Select
                    style={{borderColor:errors.roleId ? 'red' : '#02A7F0'}}
                    {...register(`roleId`, {
                      required: '请选择角色',
                      onChange: (e) => {
                        setRoleId(e.target.value)
                      }
                    })}
                    width={300}
                  >
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                  {errors.roleId && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.roleId.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'center'} mb={5}>
                <Label>命名空间</Label>
                <Input
                  value={currentData?.namespace || ''}
                  maxLength={60}
                  disabled={true}
                  readOnly
                />
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>网络服务数量</Label>
                <Box flex={1}>
                  <Input
                    type='number'
                    style={{borderColor:errors.services ? 'red' : '#02A7F0'}}
                    {...register(`services`, {
                      required: '请输入网络服务数量',
                      valueAsNumber: true
                    })}
                    onInput={(e:any) => {
                      if (e.target.value.length > 7) {
                        e.target.value = e.target.value.slice(0, 7);
                      }
                    }}
                    maxLength={7}
                  />
                  {errors.services && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.services.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>请求存储</Label>
                <Box flex={1}>
                  <InputGroup>
                    <Input
                      type='number'
                      onInput={(e:any) => {
                        if (e.target.value.length > 7) {
                          e.target.value = e.target.value.slice(0, 7);
                        }
                      }}
                      style={{borderColor:errors.requestsStorage ? 'red' : '#02A7F0'}}
                      {...register(`requestsStorage`, {
                        required: '请输入请求存储',
                        valueAsNumber: true
                      })}
                      maxLength={7}
                    />
                    <InputRightAddon style={{ height: 32, borderColor: '#02A7F0' }}>Gi</InputRightAddon>
                  </InputGroup>
                  {errors.requestsStorage && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.requestsStorage.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>磁盘数量</Label>
                <Box flex={1}>
                  <Input
                    type='number'
                    onInput={(e:any) => {
                      if (e.target.value.length > 7) {
                        e.target.value = e.target.value.slice(0, 7);
                      }
                    }}
                    style={{borderColor:errors.persistentVolumeClaims ? 'red' : '#02A7F0'}}
                    {...register(`persistentVolumeClaims`, {
                      required: '请输入磁盘数量',
                      valueAsNumber: true
                    })}
                    maxLength={60}
                  />
                  {errors.persistentVolumeClaims && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.persistentVolumeClaims.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>CPU 限制</Label>
                <Box flex={1}>
                  <Input
                    type='number'
                    onInput={(e:any) => {
                      if (e.target.value.length > 7) {
                        e.target.value = e.target.value.slice(0, 7);
                      }
                    }}
                    style={{borderColor:errors.limitsCpu ? 'red' : '#02A7F0'}}
                    {...register(`limitsCpu`, {
                      required: '请输入CPU限制',
                      valueAsNumber: true
                    })}
                    maxLength={60}
                  />
                  {errors.limitsCpu && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.limitsCpu.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
              <Flex alignItems={'flex-start'} mb={5}>
                <Label mt={2}>内存限制</Label>
                <Box flex={1}>
                  <InputGroup>
                    <Input
                      type='number'
                      onInput={(e:any) => {
                        if (e.target.value.length > 7) {
                          e.target.value = e.target.value.slice(0, 7);
                        }
                      }}
                      style={{borderColor:errors.limitsMemory ? 'red' : '#02A7F0'}}
                      {...register(`limitsMemory`, {
                        required: '请输入内存限制',
                        valueAsNumber: true
                      })}
                      maxLength={60}
                    />
                    <InputRightAddon style={{ height: 32, borderColor: '#02A7F0' }}>Gi</InputRightAddon>
                  </InputGroup>
                  {errors.limitsMemory && (
                    <Box color="red.500" fontSize="sm" mt={1}>
                      {String(errors.limitsMemory.message)}
                    </Box>
                  )}
                </Box>
              </Flex>
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button 
              colorScheme="blue" 
              mr={3} 
              onClick={handleSubmit(
                onEditConfirm,
                (errors) => {
                  console.log('表单验证错误:', errors);
                  // 找到第一个错误并显示
                  const firstError = Object.keys(errors)[0];
                  const errorMessage = errors[firstError]?.message || '请检查表单输入';
                  toast({
                    status: 'error',
                    title: `${firstError}: ${errorMessage}`,
                    duration: 5000
                  });
                }
              )}
            >
              确认
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}

export default React.memo(AppList)
